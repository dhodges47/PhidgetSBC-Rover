"use strict";

; (function () {
	var has_require = typeof require !== "undefined";
	var isNode = (typeof module !== "undefined" && module.exports);

	if (isNode) {
		var url = require('url');
		var net = require('net');
		var crypto = require('crypto');
		var btoa = require('btoa');
	}

	/*
	 * Add if missing from browser (IE11)
	 */
	if (!String.startsWith) {
		String.prototype.startsWith = function (prefix) {

			return (this.indexOf(prefix) === 0);
		}
	}

	var Connections = {};		/* List of connections */
	var ConnectionID = 1;		/* ID of next Connection */
	var UserPhidgets = {};		/* User Created Phidgets */
	var UserPhidgetID = 1;		/* ID of next User Phidget */
	var Managers = {};			/* User Created Managers */
	var ManagerID = 1;			/* ID of next Manager */

	var Epoch = Date.now();

	function tm() {

		return (Date.now() - Epoch);
	}

	var loglevel = 1;
	function debug(msg) {

		if (loglevel === 0)
			console.log('debug(' + tm() + '): ' + msg);
	}

	// Marshals a string to Uint8Array.
	function encodeUTF8(s) {
		var i = 0;
		var bytes = new Uint8Array(s.length * 4);
		for (var ci = 0; ci != s.length; ci++) {
			var c = s.charCodeAt(ci);
			if (c < 128) {
				bytes[i++] = c;
				continue;
			}
			if (c < 2048) {
				bytes[i++] = c >> 6 | 192;
			} else {
				if (c > 0xd7ff && c < 0xdc00) {
					if (++ci == s.length) throw 'UTF-8 encode: incomplete surrogate pair';
					var c2 = s.charCodeAt(ci);
					if (c2 < 0xdc00 || c2 > 0xdfff) throw 'UTF-8 encode: second char code 0x' + c2.toString(16) + ' at index ' + ci + ' in surrogate pair out of range';
					c = 0x10000 + ((c & 0x03ff) << 10) + (c2 & 0x03ff);
					bytes[i++] = c >> 18 | 240;
					bytes[i++] = c >> 12 & 63 | 128;
				} else { // c <= 0xffff
					bytes[i++] = c >> 12 | 224;
				}
				bytes[i++] = c >> 6 & 63 | 128;
			}
			bytes[i++] = c & 63 | 128;
		}
		return bytes.subarray(0, i);
	}

	// Unmarshals an Uint8Array to string.
	function decodeUTF8(bytes) {
		var s = '';
		var i = 0;
		while (i < bytes.length) {
			var c = bytes[i++];
			if (c > 127) {
				if (c > 191 && c < 224) {
					if (i >= bytes.length) throw 'UTF-8 decode: incomplete 2-byte sequence';
					c = (c & 31) << 6 | bytes[i] & 63;
				} else if (c > 223 && c < 240) {
					if (i + 1 >= bytes.length) throw 'UTF-8 decode: incomplete 3-byte sequence';
					c = (c & 15) << 12 | (bytes[i] & 63) << 6 | bytes[++i] & 63;
				} else if (c > 239 && c < 248) {
					if (i + 2 >= bytes.length) throw 'UTF-8 decode: incomplete 4-byte sequence';
					c = (c & 7) << 18 | (bytes[i] & 63) << 12 | (bytes[++i] & 63) << 6 | bytes[++i] & 63;
				} else throw 'UTF-8 decode: unknown multibyte start 0x' + c.toString(16) + ' at index ' + (i - 1);
				++i;
			}

			if (c <= 0xffff) s += String.fromCharCode(c);
			else if (c <= 0x10ffff) {
				c -= 0x10000;
				s += String.fromCharCode(c >> 10 | 0xd800)
				s += String.fromCharCode(c & 0x3FF | 0xdc00)
			} else throw 'UTF-8 decode: code point 0x' + c.toString(16) + ' exceeds UTF-16 reach';
		}
		return s;
	}

	var phidget22 = function () {
		/* HEADER is provided by start.js */

		var self = {};

		var NET_NAME = "jPhidget"
		if (isNode)
			var NET_TYPE = "www,nodejs";
		else
			var NET_TYPE = "www";
		var NET_MAJOR = 2;
		var NET_MINOR = 0;
		var NET_IDENT = "phidgetclient";

		var P22MSG = {
			Connect: 10,
			Command: 20,
			Device: 30
		}

		var P22SMSG = {
			/* Connect */
			HandShakeC0: 10,
			HandShakeS0: 11,
			AuthC0: 30,
			AuthS0: 31,
			AuthC1: 32,
			AuthS1: 33,
			/* Command */
			Reply: 40,
			KeepAlive: 41,
			/* Device */
			Attach: 50,
			Detach: 55,
			Open: 60,
			Close: 65,
			BridgePkt: 70,
			Channel: 80
		}

		var NR = {
			Magic: 0x50484930,
			Request: 0x01,
			Reply: 0x02,
			Event: 0x04
		}

		function getRandomInt(min, max) {

			return (Math.floor(Math.random() * (max - min)) + min);
		}

		function createSalt(len) {

			if (isNode) {
				var buf = crypto.randomBytes(len);
				return (btoa(buf).substring(len));
			} else {
				var buf = new Int8Array(len);
				if (window.crypto) {
					window.crypto.getRandomValues(buf);
				} else if (window.msCrypto) {
					window.msCrypto.getRandomValues(buf);
				} else {
					Math.seedrandom();
					for (var i = 0; i < len; i++)
						buf[i] = getRandomInt(0, 256);
				}
				return (window.btoa(buf.buffer).substring(len));
			}
		}

		function jPhidget_reject(code, msg) {

			return (Promise.reject(new PhidgetError(code, msg)));
		}

		function getPhidgetConstructor(cls) {

			var name = ChannelClassName[cls].substring(7);

			if (self[name])
				return (self[name]);

			return (null);
		}

		function scanChannels(phid) {

			for (var c in Connections) {
				if (Connections[c].matchPhidget(phid))
					return;
			}
		}

		function scanUserPhidgets(ch) {

			for (var ph in UserPhidgets) {
				var phid = UserPhidgets[ph];

				if (phid.attaching === true || phid.isopen === true)
					continue;

				if (ch === undefined) {
					if (scanChannels(phid) === true)
						return;
				} else if (ch.match(phid)) {
					ch.open(phid).catch(function (err) {
						if (this.onError)
							this.onError(err.errorCode, err.message);
						else
							console.error(err);
					}.bind(phid));
					return;
				}
			}
		}

		setInterval(function () {

			scanUserPhidgets();
		}, 1000);

		setInterval(function () {
			for (var ph in UserPhidgets) {
				var phid = UserPhidgets[ph];
				if (phid.isopen)
					continue;
				if (phid.openTimeout == undefined)
					continue;
				if (tm() - phid.openTime > phid.openTimeout)
					phid.openTimedOut();
			}
		}, 500);

		self.getLibraryVersion = function () {

			return ("Phidget22 1.1");
		}

		self.getJSLibraryVersion = function () {

			return ("2.x.x");
		}

		/* Exported for use by Control Panel */
		self.Connections = Connections;

		/* FOOTER is provided by end.js */


		/**************************************************************************************************
		 * Request
		 */

		/*
		 * Constructor takes either a buffer to parse, or the parameters to create a new request.
		 */
		var Request = function (dataOrLength, flags, reqseq, repseq, type, stype) {

			if (typeof stype !== 'undefined')
				this.buffer = this.render(dataOrLength, flags, reqseq, repseq, type, stype);
			else if (typeof dataOrLength !== 'undefined')
				this.hdrlen = this.parse(dataOrLength);
		}

		Request.prototype.toString = function () {

			return ('{flags:0x' + this.flags.toString(16) + ' len:' + this.len +
				' reqseq:' + this.reqseq + ' repseq:' + this.repseq +
				' type:' + this.type + ' subtype:' + this.stype + '}');
		}

		Request.prototype.parse = function (buf) {

			this.magic = (buf[3] << 24) | (buf[2] << 16) | (buf[1] << 8) | buf[0];
			this.len = (buf[7] << 24) | (buf[6] << 16) | (buf[5] << 8) | buf[4];
			this.flags = (buf[9] << 8) | buf[8];
			this.reqseq = (buf[11] << 8) | buf[10];
			this.repseq = (buf[13] << 8) | buf[12];
			this.type = buf[14];
			this.stype = buf[15];

			if (this.magic != NR.Magic)
				throw ("Bad Request Magic");

			return (16);
		}

		Request.prototype.render = function (len, flags, reqseq, repseq, type, stype) {
			var array = new Uint8Array(16);

			array[3] = (NR.Magic >> 24) & 0xff;
			array[2] = (NR.Magic >> 16) & 0xff;
			array[1] = (NR.Magic >> 8) & 0xff;
			array[0] = NR.Magic & 0xff;
			array[7] = (len >> 24) & 0xff;
			array[6] = (len >> 16) & 0xff;
			array[5] = (len >> 8) & 0xff;
			array[4] = len & 0xff;
			array[9] = (flags >> 8) & 0xff;
			array[8] = flags & 0xff;
			array[11] = (reqseq >> 8) & 0xff;
			array[10] = reqseq & 0xff;
			array[13] = (repseq >> 8) & 0xff;
			array[12] = repseq & 0xff;
			array[14] = type;
			array[15] = stype;

			return (array);
		}

		var EncoderIOMode = {
			PUSH_PULL: 1,
			LINE_DRIVER_2K2: 2,
			LINE_DRIVER_10K: 3,
			OPEN_COLLECTOR_2K2: 4,
			OPEN_COLLECTOR_10K: 5,
		};
		self.EncoderIOMode = EncoderIOMode;

		var ErrorCode = {
			SUCCESS: 0,
			NOT_PERMITTED: 1,
			NO_SUCH_ENTITY: 2,
			TIMEOUT: 3,
			KEEP_ALIVE: 58,
			INTERRUPTED: 4,
			IO: 5,
			NO_MEMORY: 6,
			ACCESS: 7,
			FAULT: 8,
			BUSY: 9,
			EXISTS: 10,
			IS_NOT_DIRECTORY: 11,
			IS_DIRECTORY: 12,
			INVALID: 13,
			TOO_MANY_FILES_SYSTEM: 14,
			TOO_MANY_FILES: 15,
			NO_SPACE: 16,
			FILE_TOO_BIG: 17,
			READ_ONLY_FILESYSTEM: 18,
			READ_ONLY: 19,
			UNSUPPORTED: 20,
			INVALID_ARGUMENT: 21,
			TRY_AGAIN: 22,
			NOT_EMPTY: 26,
			UNEXPECTED: 28,
			DUPLICATE: 27,
			BAD_PASSWORD: 37,
			NETWORK_UNAVAILABLE: 45,
			CONNECTION_REFUSED: 35,
			CONNECTION_RESET: 46,
			HOST_UNREACHABLE: 48,
			NO_SUCH_DEVICE: 40,
			WRONG_DEVICE: 50,
			BROKEN_PIPE: 41,
			NAME_RESOLUTION_FAILURE: 44,
			UNKNOWN_VALUE: 51,
			NOT_ATTACHED: 52,
			INVALID_PACKET: 53,
			TOO_BIG: 54,
			BAD_VERSION: 55,
			CLOSED: 56,
			NOT_CONFIGURED: 57,
			END_OF_FILE: 31,
			FAILSAFE: 59,
		};
		self.ErrorCode = ErrorCode;

		var ErrorEventCode = {
			BAD_VERSION: 1,
			BUSY: 2,
			NETWORK: 3,
			DISPATCH: 4,
			FAILURE: 5,
			SUCCESS: 4096,
			OVERRUN: 4098,
			PACKET_LOST: 4099,
			WRAP_AROUND: 4100,
			OVER_TEMPERATURE: 4101,
			OVER_CURRENT: 4102,
			OUT_OF_RANGE: 4103,
			BAD_POWER: 4104,
			SATURATION: 4105,
			OVER_VOLTAGE: 4107,
			FAILSAFE_CONDITION: 4108,
			VOLTAGE_ERROR: 4109,
			ENERGY_DUMP_CONDITION: 4110,
			MOTOR_STALL_CONDITION: 4111,
		};
		self.ErrorEventCode = ErrorEventCode;

		var DeviceID = {
			NONE: 0,
			PN_INTERFACE_KIT488: 1,
			PN_1000: 2,
			PN_1001: 3,
			PN_1002: 4,
			PN_1008: 5,
			PN_1010_1013_1018_1019: 6,
			PN_1011: 7,
			PN_1012: 8,
			PN_1014: 9,
			PN_1015: 10,
			PN_1016: 11,
			PN_1017: 12,
			PN_1023: 13,
			PN_1024: 14,
			PN_1030: 15,
			PN_1031: 16,
			PN_1032: 17,
			PN_1040: 18,
			PN_1041: 19,
			PN_1042: 20,
			PN_1043: 21,
			PN_1044: 22,
			PN_1045: 23,
			PN_1046: 24,
			PN_1047: 25,
			PN_1048: 26,
			PN_1049: 27,
			PN_1051: 28,
			PN_1052: 29,
			PN_1053: 30,
			PN_1054: 31,
			PN_1055: 32,
			PN_1056: 33,
			PN_1057: 34,
			PN_1058: 35,
			PN_1059: 36,
			PN_1060: 37,
			PN_1061: 38,
			PN_1062: 39,
			PN_1063: 40,
			PN_1064: 41,
			PN_1065: 42,
			PN_1066: 43,
			PN_1067: 44,
			PN_1202_1203: 45,
			PN_1204: 46,
			PN_1215__1218: 47,
			PN_1219__1222: 48,
			PN_ADP1000: 49,
			PN_ADP1001: 50,
			PN_DAQ1000: 51,
			PN_DAQ1200: 52,
			PN_DAQ1300: 53,
			PN_DAQ1301: 54,
			PN_DAQ1400: 55,
			PN_DAQ1500: 56,
			PN_DCC1000: 57,
			PN_DST1000: 58,
			PN_DST1200: 59,
			PN_ENC1000: 60,
			PN_HIN1000: 61,
			PN_HIN1001: 62,
			PN_HIN1100: 63,
			PN_HUB0000: 64,
			PN_HUB0001: 65,
			PN_HUB0002: 66,
			PN_HUB0004: 67,
			PN_HUB0005: 68,
			PN_HUM1000: 69,
			PN_LCD1100: 70,
			PN_LED1000: 71,
			PN_LUX1000: 72,
			PN_MOT1100: 73,
			PN_MOT1101: 74,
			PN_OUT1000: 75,
			PN_OUT1001: 76,
			PN_OUT1002: 77,
			PN_OUT1100: 78,
			PN_PRE1000: 79,
			PN_RCC1000: 80,
			PN_REL1000: 81,
			PN_REL1100: 82,
			PN_REL1101: 83,
			PN_SAF1000: 84,
			PN_SND1000: 85,
			PN_STC1000: 86,
			PN_TMP1000: 87,
			PN_TMP1100: 88,
			PN_TMP1101: 89,
			PN_TMP1200: 90,
			PN_TMP1300: 91,
			PN_VCP1000: 92,
			PN_VCP1001: 93,
			PN_VCP1002: 94,
			DIGITAL_INPUT_PORT: 95,
			DIGITAL_OUTPUT_PORT: 96,
			VOLTAGE_INPUT_PORT: 97,
			VOLTAGE_RATIO_INPUT_PORT: 98,
			GENERIC_USB: 99,
			GENERIC_VINT: 100,
			FIRMWARE_UPGRADE_USB: 101,
			FIRMWARE_UPGRADE_STM32F0: 102,
			FIRMWARE_UPGRADE_STM8S: 103,
			FIRMWARE_UPGRADE_SPI: 104,
			PN_VCP1100: 105,
			PN_DCC1100: 108,
			PN_HIN1101: 109,
			PN_DCC1001: 110,
			PN_DICTIONARY: 111,
			PN_STC1001: 115,
			PN_USBSWITCH: 116,
			PN_DCC1002: 117,
			PN_STC1002: 118,
			PN_STC1003: 119,
			PN_DCC1003: 120,
			PN_DST1001: 121,
			PN_CURLOOP: 122,
			PN_HUB5000: 123,
			PN_RCC0004: 124,
		};
		self.DeviceID = DeviceID;

		var DeviceClass = {
			NONE: 0,
			ACCELEROMETER: 1,
			ADVANCED_SERVO: 2,
			ANALOG: 3,
			BRIDGE: 4,
			ENCODER: 5,
			FREQUENCY_COUNTER: 6,
			GPS: 7,
			HUB: 8,
			INTERFACE_KIT: 9,
			IR: 10,
			LED: 11,
			MESH_DONGLE: 12,
			MOTOR_CONTROL: 13,
			PH_SENSOR: 14,
			RFID: 15,
			SERVO: 16,
			SPATIAL: 17,
			STEPPER: 18,
			TEMPERATURE_SENSOR: 19,
			TEXT_LCD: 20,
			VINT: 21,
			GENERIC: 22,
			FIRMWARE_UPGRADE: 23,
			DICTIONARY: 24,
		};
		self.DeviceClass = DeviceClass;

		var ChannelClass = {
			NONE: 0,
			ACCELEROMETER: 1,
			CURRENT_INPUT: 2,
			DATA_ADAPTER: 3,
			DC_MOTOR: 4,
			DIGITAL_INPUT: 5,
			DIGITAL_OUTPUT: 6,
			DISTANCE_SENSOR: 7,
			ENCODER: 8,
			FREQUENCY_COUNTER: 9,
			GPS: 10,
			LCD: 11,
			GYROSCOPE: 12,
			HUB: 13,
			CAPACITIVE_TOUCH: 14,
			HUMIDITY_SENSOR: 15,
			IR: 16,
			LIGHT_SENSOR: 17,
			MAGNETOMETER: 18,
			MESH_DONGLE: 19,
			PH_SENSOR: 37,
			POWER_GUARD: 20,
			PRESSURE_SENSOR: 21,
			RC_SERVO: 22,
			RESISTANCE_INPUT: 23,
			RFID: 24,
			SOUND_SENSOR: 25,
			SPATIAL: 26,
			STEPPER: 27,
			TEMPERATURE_SENSOR: 28,
			VOLTAGE_INPUT: 29,
			VOLTAGE_OUTPUT: 30,
			VOLTAGE_RATIO_INPUT: 31,
			FIRMWARE_UPGRADE: 32,
			GENERIC: 33,
			MOTOR_POSITION_CONTROLLER: 34,
			BLDC_MOTOR: 35,
			DICTIONARY: 36,
			CURRENT_OUTPUT: 38,
		};
		self.ChannelClass = ChannelClass;

		var ChannelSubclass = {
			NONE: 1,
			DIGITAL_OUTPUT_DUTY_CYCLE: 16,
			DIGITAL_OUTPUT_LEDDRIVER: 17,
			TEMPERATURE_SENSOR_RTD: 32,
			TEMPERATURE_SENSOR_THERMOCOUPLE: 33,
			VOLTAGE_INPUT_SENSOR_PORT: 48,
			VOLTAGE_RATIO_INPUT_SENSOR_PORT: 64,
			VOLTAGE_RATIO_INPUT_BRIDGE: 65,
			LCD_GRAPHIC: 80,
			LCD_TEXT: 81,
			ENCODER_MODE_SETTABLE: 96,
		};
		self.ChannelSubclass = ChannelSubclass;

		var MeshMode = {
			ROUTER: 1,
			SLEEPY_END_DEVICE: 2,
		};
		self.MeshMode = MeshMode;

		var PowerSupply = {
			OFF: 1,
			VOLTS_12: 2,
			VOLTS_24: 3,
		};
		self.PowerSupply = PowerSupply;

		var RTDWireSetup = {
			WIRES_2: 1,
			WIRES_3: 2,
			WIRES_4: 3,
		};
		self.RTDWireSetup = RTDWireSetup;

		var InputMode = {
			NPN: 1,
			PNP: 2,
		};
		self.InputMode = InputMode;

		var FanMode = {
			OFF: 1,
			ON: 2,
			AUTO: 3,
		};
		self.FanMode = FanMode;

		var SpatialPrecision = {
			HYBRID: 0,
			HIGH: 1,
			LOW: 2,
		};
		self.SpatialPrecision = SpatialPrecision;

		var Unit = {
			NONE: 0,
			BOOLEAN: 1,
			PERCENT: 2,
			DECIBEL: 3,
			MILLIMETER: 4,
			CENTIMETER: 5,
			METER: 6,
			GRAM: 7,
			KILOGRAM: 8,
			MILLIAMPERE: 9,
			AMPERE: 10,
			KILOPASCAL: 11,
			VOLT: 12,
			DEGREE_CELCIUS: 13,
			LUX: 14,
			GAUSS: 15,
			PH: 16,
			WATT: 17,
		};
		self.Unit = Unit;

		var LEDForwardVoltage = {
			VOLTS_1_7: 1,
			VOLTS_2_75: 2,
			VOLTS_3_2: 3,
			VOLTS_3_9: 4,
			VOLTS_4_0: 5,
			VOLTS_4_8: 6,
			VOLTS_5_0: 7,
			VOLTS_5_6: 8,
		};
		self.LEDForwardVoltage = LEDForwardVoltage;

		var FrequencyFilterType = {
			ZERO_CROSSING: 1,
			LOGIC_LEVEL: 2,
		};
		self.FrequencyFilterType = FrequencyFilterType;

		var HubPortMode = {
			VINT: 0,
			DIGITAL_INPUT: 1,
			DIGITAL_OUTPUT: 2,
			VOLTAGE_INPUT: 3,
			VOLTAGE_RATIO_INPUT: 4,
		};
		self.HubPortMode = HubPortMode;

		var IRCodeEncoding = {
			UNKNOWN: 1,
			SPACE: 2,
			PULSE: 3,
			BI_PHASE: 4,
			RC5: 5,
			RC6: 6,
		};
		self.IRCodeEncoding = IRCodeEncoding;

		var IRCodeLength = {
			UNKNOWN: 1,
			CONSTANT: 2,
			VARIABLE: 3,
		};
		self.IRCodeLength = IRCodeLength;

		var LCDFont = {
			USER1: 1,
			USER2: 2,
			DIMENSIONS_6X10: 3,
			DIMENSIONS_5X8: 4,
			DIMENSIONS_6X12: 5,
		};
		self.LCDFont = LCDFont;

		var LCDScreenSize = {
			NO_SCREEN: 1,
			DIMENSIONS_1X8: 2,
			DIMENSIONS_2X8: 3,
			DIMENSIONS_1X16: 4,
			DIMENSIONS_2X16: 5,
			DIMENSIONS_4X16: 6,
			DIMENSIONS_2X20: 7,
			DIMENSIONS_4X20: 8,
			DIMENSIONS_2X24: 9,
			DIMENSIONS_1X40: 10,
			DIMENSIONS_2X40: 11,
			DIMENSIONS_4X40: 12,
			DIMENSIONS_64X128: 13,
		};
		self.LCDScreenSize = LCDScreenSize;

		var LCDPixelState = {
			OFF: 0,
			ON: 1,
			INVERT: 2,
		};
		self.LCDPixelState = LCDPixelState;

		var RCServoVoltage = {
			VOLTS_5_0: 1,
			VOLTS_6_0: 2,
			VOLTS_7_4: 3,
		};
		self.RCServoVoltage = RCServoVoltage;

		var RFIDProtocol = {
			EM4100: 1,
			ISO11785_FDX_B: 2,
			PHIDGET_TAG: 3,
		};
		self.RFIDProtocol = RFIDProtocol;

		var SPLRange = {
			DB_102: 1,
			DB_82: 2,
		};
		self.SPLRange = SPLRange;

		var SpatialAlgorithm = {
			NONE: 0,
			AHRS: 1,
			IMU: 2,
		};
		self.SpatialAlgorithm = SpatialAlgorithm;

		var StepperControlMode = {
			STEP: 0,
			RUN: 1,
		};
		self.StepperControlMode = StepperControlMode;

		var RTDType = {
			PT100_3850: 1,
			PT1000_3850: 2,
			PT100_3920: 3,
			PT1000_3920: 4,
		};
		self.RTDType = RTDType;

		var ThermocoupleType = {
			J: 1,
			K: 2,
			E: 3,
			T: 4,
		};
		self.ThermocoupleType = ThermocoupleType;

		var VoltageRange = {
			MILLIVOLTS_10: 1,
			MILLIVOLTS_40: 2,
			MILLIVOLTS_200: 3,
			MILLIVOLTS_312_5: 4,
			MILLIVOLTS_400: 5,
			MILLIVOLTS_1000: 6,
			VOLTS_2: 7,
			VOLTS_5: 8,
			VOLTS_15: 9,
			VOLTS_40: 10,
			AUTO: 11,
		};
		self.VoltageRange = VoltageRange;

		var VoltageSensorType = {
			VOLTAGE: 0,
			PN_1114: 11140,
			PN_1117: 11170,
			PN_1123: 11230,
			PN_1127: 11270,
			PN_1130_PH: 11301,
			PN_1130_ORP: 11302,
			PN_1132: 11320,
			PN_1133: 11330,
			PN_1135: 11350,
			PN_1142: 11420,
			PN_1143: 11430,
			PN_3500: 35000,
			PN_3501: 35010,
			PN_3502: 35020,
			PN_3503: 35030,
			PN_3507: 35070,
			PN_3508: 35080,
			PN_3509: 35090,
			PN_3510: 35100,
			PN_3511: 35110,
			PN_3512: 35120,
			PN_3513: 35130,
			PN_3514: 35140,
			PN_3515: 35150,
			PN_3516: 35160,
			PN_3517: 35170,
			PN_3518: 35180,
			PN_3519: 35190,
			PN_3584: 35840,
			PN_3585: 35850,
			PN_3586: 35860,
			PN_3587: 35870,
			PN_3588: 35880,
			PN_3589: 35890,
		};
		self.VoltageSensorType = VoltageSensorType;

		var VoltageOutputRange = {
			VOLTS_10: 1,
			VOLTS_5: 2,
		};
		self.VoltageOutputRange = VoltageOutputRange;

		var BridgeGain = {
			GAIN_1X: 1,
			GAIN_2X: 2,
			GAIN_4X: 3,
			GAIN_8X: 4,
			GAIN_16X: 5,
			GAIN_32X: 6,
			GAIN_64X: 7,
			GAIN_128X: 8,
		};
		self.BridgeGain = BridgeGain;

		var VoltageRatioSensorType = {
			VOLTAGE_RATIO: 0,
			PN_1101_SHARP2D120X: 11011,
			PN_1101_SHARP2Y0A21: 11012,
			PN_1101_SHARP2Y0A02: 11013,
			PN_1102: 11020,
			PN_1103: 11030,
			PN_1104: 11040,
			PN_1105: 11050,
			PN_1106: 11060,
			PN_1107: 11070,
			PN_1108: 11080,
			PN_1109: 11090,
			PN_1110: 11100,
			PN_1111: 11110,
			PN_1112: 11120,
			PN_1113: 11130,
			PN_1115: 11150,
			PN_1116: 11160,
			PN_1118_AC: 11181,
			PN_1118_DC: 11182,
			PN_1119_AC: 11191,
			PN_1119_DC: 11192,
			PN_1120: 11200,
			PN_1121: 11210,
			PN_1122_AC: 11221,
			PN_1122_DC: 11222,
			PN_1124: 11240,
			PN_1125_HUMIDITY: 11251,
			PN_1125_TEMPERATURE: 11252,
			PN_1126: 11260,
			PN_1128: 11280,
			PN_1129: 11290,
			PN_1131: 11310,
			PN_1134: 11340,
			PN_1136: 11360,
			PN_1137: 11370,
			PN_1138: 11380,
			PN_1139: 11390,
			PN_1140: 11400,
			PN_1141: 11410,
			PN_1146: 11460,
			PN_3120: 31200,
			PN_3121: 31210,
			PN_3122: 31220,
			PN_3123: 31230,
			PN_3130: 31300,
			PN_3520: 35200,
			PN_3521: 35210,
			PN_3522: 35220,
		};
		self.VoltageRatioSensorType = VoltageRatioSensorType;



		var PhidgetErrorDescription = {
			0: 'Success',
			1: 'Not Permitted',
			2: 'No Such Entity',
			3: 'Timed Out',
			58: 'Keep Alive Failure',
			4: 'Op Interrupted',
			5: 'IO Issue',
			6: 'Memory Issue',
			7: 'Access (Permission) Issue',
			8: 'Address Issue',
			9: 'Resource Busy',
			10: 'Object Exists',
			11: 'Object is not a directory',
			12: 'Object is a directory',
			13: 'Invalid',
			14: 'Too many open files in system',
			15: 'Too many open files',
			16: 'Not enough space',
			17: 'File too Big',
			18: 'Read Only Filesystem',
			19: 'Read Only Object',
			20: 'Operation Not Supported',
			21: 'Invalid Argument',
			22: 'Try again',
			26: 'Not Empty',
			28: 'Unexpected Error',
			27: 'Duplicate',
			37: 'Bad Credential',
			45: 'Network Unavailable',
			35: 'Connection Refused',
			46: 'Connection Reset',
			48: 'No route to host',
			40: 'No Such Device',
			50: 'Wrong Device',
			41: 'Broken Pipe',
			44: 'Name Resolution Failure',
			51: 'Unknown or Invalid Value',
			52: 'Device not Attached',
			53: 'Invalid or Unexpected Packet',
			54: 'Argument List Too Long',
			55: 'Bad Version',
			56: 'Closed',
			57: 'Not Configured',
			31: 'End of File',
			59: 'Failsafe Triggered',
		};


		var PhidgetError = function PhidgetError(code, message) {
			this.name = "PhidgetError";
			this.errorCode = code;
			this.message = (message || PhidgetErrorDescription[code]);
			this.stack = (new Error()).stack;
		};
		PhidgetError.prototype = Error.prototype;
		self.PhidgetError = PhidgetError;

		var BridgePackets = {
			BP_SETSTATUS: 0,
			BP_ACCELERATIONCHANGE: 1,
			BP_ANGULARRATEUPDATE: 2,
			BP_BACKEMFCHANGE: 3,
			BP_CLEAR: 4,
			BP_CODE: 5,
			BP_COPY: 6,
			BP_COUNTCHANGE: 7,
			BP_CURRENTCHANGE: 8,
			BP_DATA: 9,
			BP_DATAINTERVALCHANGE: 10,
			BP_DBCHANGE: 11,
			BP_DISTANCECHANGE: 12,
			BP_DRAWLINE: 13,
			BP_DRAWPIXEL: 14,
			BP_DRAWRECT: 15,
			BP_DUTYCYCLECHANGE: 16,
			BP_ERROREVENT: 17,
			BP_FIELDSTRENGTHCHANGE: 18,
			BP_FLUSH: 19,
			BP_FREQUENCYCHANGE: 20,
			BP_FREQUENCYDATA: 21,
			BP_HUMIDITYCHANGE: 22,
			BP_ILLUMINANCECHANGE: 23,
			BP_INITIALIZE: 24,
			BP_LEARN: 25,
			BP_MANCHESTER: 26,
			BP_MINDATAINTERVALCHANGE: 27,
			BP_PACKET: 28,
			BP_POSITIONCHANGE: 29,
			BP_POSITIONFIXSTATUSCHANGE: 30,
			BP_PRESSURECHANGE: 31,
			BP_RAWDATA: 32,
			BP_REPEAT: 33,
			BP_OPENRESET: 34,
			BP_RESETCORRECTIONPARAMETERS: 35,
			BP_RESISTANCECHANGE: 36,
			BP_SAVECORRECTIONPARAMETERS: 37,
			BP_SAVEFRAMEBUFFER: 38,
			BP_SENDPACKET: 39,
			BP_SETACCELERATION: 40,
			BP_SETANTENNAON: 41,
			BP_SETBACKEMFSENSINGSTATE: 42,
			BP_SETBACKLIGHT: 43,
			BP_SETBRAKINGDUTYCYCLE: 44,
			BP_SETBRIDGEGAIN: 45,
			BP_SETCHANGETRIGGER: 46,
			BP_SETCHARACTERBITMAP: 47,
			BP_SETCONTRAST: 48,
			BP_SETCONTROLMODE: 49,
			BP_SETCORRECTIONPARAMETERS: 50,
			BP_SETCURRENTLIMIT: 51,
			BP_SETCURSORBLINK: 52,
			BP_SETCURSORON: 53,
			BP_SETDATAINTERVAL: 54,
			BP_SETDUTYCYCLE: 55,
			BP_SETENABLED: 56,
			BP_SETENGAGED: 57,
			BP_SETFANMODE: 58,
			BP_SETFILTERTYPE: 59,
			BP_SETFIRMWAREUPGRADEFLAG: 60,
			BP_SETFONTSIZE: 61,
			BP_SETFRAMEBUFFER: 62,
			BP_SETHOLDINGCURRENTLIMIT: 63,
			BP_SETINPUTMODE: 64,
			BP_SETIOMODE: 65,
			BP_SETSENSITIVITY: 66,
			BP_SETLEDCURRENTLIMIT: 67,
			BP_SETLEDFORWARDVOLTAGE: 68,
			BP_SETMAXPULSEWIDTH: 69,
			BP_SETMINPULSEWIDTH: 70,
			BP_SETOVERVOLTAGE: 71,
			BP_SETPORTMODE: 72,
			BP_SETPORTPOWER: 73,
			BP_SETPOWERSUPPLY: 74,
			BP_SETSONARQUIETMODE: 75,
			BP_SETRTDTYPE: 76,
			BP_SETRTDWIRESETUP: 77,
			BP_SETSCREENSIZE: 78,
			BP_SETSENSORTYPE: 79,
			BP_SETSLEEP: 80,
			BP_SETSPEEDRAMPINGSTATE: 81,
			BP_SETSTATE: 82,
			BP_SETTARGETPOSITION: 83,
			BP_SETTHERMOCOUPLETYPE: 84,
			BP_SETVELOCITYLIMIT: 85,
			BP_SETVOLTAGE: 86,
			BP_SETVOLTAGERANGE: 87,
			BP_SONARUPDATE: 88,
			BP_SPATIALDATA: 89,
			BP_STATECHANGE: 90,
			BP_STOPPED: 91,
			BP_TAG: 92,
			BP_TAGLOST: 93,
			BP_TARGETPOSITIONREACHED: 94,
			BP_TEMPERATURECHANGE: 95,
			BP_TOUCHINPUTVALUECHANGE: 96,
			BP_TRANSMIT: 97,
			BP_TRANSMITRAW: 98,
			BP_TRANSMITREPEAT: 99,
			BP_VELOCITYCHANGE: 100,
			BP_VOLTAGECHANGE: 101,
			BP_VOLTAGERATIOCHANGE: 102,
			BP_WRITE: 103,
			BP_WRITEBITMAP: 104,
			BP_WRITETEXT: 105,
			BP_ZERO: 106,
			BP_SETCALIBRATIONVALUES: 107,
			BP_TIME: 108,
			BP_DATE: 109,
			BP_HEADINGCHANGE: 110,
			BP_CLOSERESET: 111,
			BP_SENDFIRMWARE: 112,
			BP_PROGRESSCHANGE: 113,
			BP_DEVICEINFO: 114,
			BP_SENSORCHANGE: 115,
			BP_SETSPLRANGE: 116,
			BP_DATAIN: 117,
			BP_DATAOUT: 118,
			BP_SETCURRENTREGULATORGAIN: 119,
			BP_SETDEADBAND: 120,
			BP_BRAKINGSTRENGTHCHANGE: 121,
			BP_SETSENSORVALUECHANGETRIGGER: 122,
			BP_DICTIONARYADD: 123,
			BP_DICTIONARYADDED: 124,
			BP_DICTIONARYUPDATE: 125,
			BP_DICTIONARYUPDATED: 126,
			BP_DICTIONARYREMOVE: 127,
			BP_DICTIONARYREMOVED: 128,
			BP_DICTIONARYGET: 129,
			BP_DICTIONARYSET: 130,
			BP_DICTIONARYREMOVEALL: 131,
			BP_DICTIONARYSCAN: 132,
			BP_PHCHANGE: 133,
			BP_SETCORRECTIONTEMPERATURE: 134,
			BP_SETKP: 135,
			BP_SETKD: 136,
			BP_TOUCHINPUTEND: 137,
			BP_REBOOTFIRMWAREUPGRADE: 138,
			BP_REBOOT: 139,
			BP_WRITELABEL: 140,
			BP_SETSTALLVELOCITY: 141,
			BP_SETKI: 142,
			BP_ENABLE: 143,
			BP_SETCURRENT: 144,
			BP_SETSPATIALPRECISION: 145,
			BP_SETFAILSAFETIME: 146,
			BP_FAILSAFERESET: 147,
			BP_SPATIALALGDATA: 148,
			BP_SETSPATIALALGORITHM: 149,
			BP_ZEROSPATIALALGORITHM: 150,
			BP_SETSPATIALALGORITHMMAGGAIN: 151,
		}


		/**************************************************************************************************
		 * BridgePacket
		 */

		var BridgePacket = function (conn, req, data) {

			this.conn = conn;
			this.req = req;

			if (data) {
				this.version = data.v;
				this.source = data.s;
				this.flags = data.f;
				this.vpkt = data.p;
				this.chid = data.O;	/* the id of the channel that we opened */
				this.channel = conn.getChannel(this.chid);
				this.channelIndex = data.X;
				this.entryCount = data.c;
				this.entries = data.e;
			} else {
				this.version = 0;
				this.source = 2;	/* JSON */
				this.flags = 0;
				this.entryCount = 0;
				this.entries = {};
			}
		}

		BridgePacket.prototype.NUMBER = 1;
		BridgePacket.prototype.FLOAT = 2;
		BridgePacket.prototype.STRING = 3;
		BridgePacket.prototype.ARRAY = 4;
		BridgePacket.prototype.JSON = 5;
		BridgePacket.prototype.F_EVENT = 0x01;

		BridgePacket.prototype.isEvent = function () {

			if (this.flags & this.F_EVENT)
				return (true);
			return (false);
		}

		BridgePacket.prototype.validType = function (type) {

			switch (type) {
				case 'c':
				case 'h':
				case 'u':
				case 'uh':
				case 'ul':
				case 'd':
				case 'l':
				case 'f':
				case 'g':
				case 's':
				case 'R':
				case 'I':
				case 'U':
				case 'J':
					return (true);
				default:
					return (false);
			}
		}

		BridgePacket.prototype.entryType = function (e) {

			switch (e.type) {
				case 'c':
				case 'h':
				case 'uh':
				case 'd':
				case 'u':
				case 'l':
				case 'ul':
					return (this.NUMBER);
				case 'f':
				case 'g':
					return (this.FLOAT);
				case 's':
					return (this.STRING);
				case 'R':
				case 'I':
				case 'G':
				case 'U':
					return (this.ARRAY);
				case 'J':
					return (this.JSON);
				default:
					return (-1);
			}
		}

		BridgePacket.prototype.convertType = function (e) {

			switch (this.entryType(e)) {
				case this.NUMBER:
					var n = parseInt(e.value);
					if (!isNaN(n))
						return (n);
					if (typeof e.value === 'boolean') {
						if (e.value)
							return (1);
						return (0);
					}
					break;
				case this.FLOAT:
					var n = parseFloat(e.value);
					if (!isNaN(n))
						return (n);
					if (typeof e.value === 'boolean') {
						if (e.value)
							return (1.0);
						return (0.0);
					}
					break;
				case this.STRING:
					if (typeof e.value !== 'string')
						return ('' + e.value);
					return (e.value);
				case this.JSON:
					if (typeof e.value === 'object')
						return (e.value);
					break;
				case this.ARRAY:
					if (Array.isArray(e.value))
						return (e.value);
					break;
			}
			throw ('invalid value [' + e.value + '] for type [' + e.type + ']');
		}

		BridgePacket.prototype.set = function (val) {

			if (typeof val === 'undefined')
				throw ('invalid argument');
			if (typeof val.name === 'undefined')
				throw ('missing name');
			if (typeof val.type === 'undefined')
				throw ('missing type');
			if (typeof val.value === 'undefined')
				throw ('missing value');

			if (val.name in this.entries)
				throw ('value [' + val.name + '] already set');

			if (!this.validType(val.type))
				throw ('invalid type [' + val.type + ']');

			var v = this.convertType(val);

			var e = {
				t: val.type,
				v: v
			};
			this.entries[val.name] = e;
			this.entryCount++;
		}

		BridgePacket.prototype.send = function (ch, vpkt) {

			var self = ch;

			if (typeof vpkt === 'string')
				vpkt = this[vpkt];

			if (!ch.isopen)
				return Promise.reject(new PhidgetError(ErrorCode.NOT_ATTACHED));

			var json = JSON.stringify({
				v: this.version,
				s: this.source,
				f: this.flags,
				p: vpkt,
				I: ch.parent.phid,
				X: ch.uniqueIndex,
				c: this.entryCount,
				e: this.entries
			});

			return (ch.conn.sendRequest(0, 0, 0, P22MSG.Device, P22SMSG.BridgePkt, json));
		}

		BridgePacket.prototype.deliver = function () {

			if (!this.channel)
				throw ('Bridge packet missing channel');
			if (this.channel.isopen === false) {
				debug('deliver event to closed channel');
				return; /* this event was delivered, but we are not open to receive it */
			}

			try {
				/* Send a reply if this is not an event, and is not setStatus() */
				if (!this.isEvent() && this.vpkt !== 0)
					this.conn.sendReply(this.req.reqseq, this.req.type, this.req.stype, []);
				this.channel.userphid.bridgeInput(this);
			} catch (e) {
				throw (e);
			}
		}

		BridgePacket.prototype.get = function (name) {

			if (this.entries.hasOwnProperty(name))
				return (this.entries[name].v);
			return (undefined);
		}


		var DeviceClassName = {
			0: 'PhidgetNone',
			1: 'PhidgetAccelerometer',
			2: 'PhidgetAdvancedServo',
			3: 'PhidgetAnalog',
			4: 'PhidgetBridge',
			5: 'PhidgetEncoder',
			6: 'PhidgetFrequencyCounter',
			7: 'PhidgetGPS',
			8: 'PhidgetHub',
			9: 'PhidgetInterfaceKit',
			10: 'PhidgetIR',
			11: 'PhidgetLED',
			12: 'PhidgetMeshDongle',
			13: 'PhidgetMotorControl',
			14: 'PhidgetPHSensor',
			15: 'PhidgetRFID',
			16: 'PhidgetServo',
			17: 'PhidgetSpatial',
			18: 'PhidgetStepper',
			19: 'PhidgetTemperatureSensor',
			20: 'PhidgetTextLCD',
			21: 'PhidgetVINT',
			22: 'PhidgetGeneric',
			23: 'PhidgetFirmwareUpgrade',
			24: 'PhidgetDictionary',
		};

		var ChannelClassName = {
			0: 'PhidgetNone',
			1: 'PhidgetAccelerometer',
			2: 'PhidgetCurrentInput',
			3: 'PhidgetDataAdapter',
			4: 'PhidgetDCMotor',
			5: 'PhidgetDigitalInput',
			6: 'PhidgetDigitalOutput',
			7: 'PhidgetDistanceSensor',
			8: 'PhidgetEncoder',
			9: 'PhidgetFrequencyCounter',
			10: 'PhidgetGPS',
			11: 'PhidgetLCD',
			12: 'PhidgetGyroscope',
			13: 'PhidgetHub',
			14: 'PhidgetCapacitiveTouch',
			15: 'PhidgetHumiditySensor',
			16: 'PhidgetIR',
			17: 'PhidgetLightSensor',
			18: 'PhidgetMagnetometer',
			19: 'PhidgetMeshDongle',
			37: 'PhidgetPHSensor',
			20: 'PhidgetPowerGuard',
			21: 'PhidgetPressureSensor',
			22: 'PhidgetRCServo',
			23: 'PhidgetResistanceInput',
			24: 'PhidgetRFID',
			25: 'PhidgetSoundSensor',
			26: 'PhidgetSpatial',
			27: 'PhidgetStepper',
			28: 'PhidgetTemperatureSensor',
			29: 'PhidgetVoltageInput',
			30: 'PhidgetVoltageOutput',
			31: 'PhidgetVoltageRatioInput',
			32: 'PhidgetFirmwareUpgrade',
			33: 'PhidgetGeneric',
			34: 'PhidgetMotorPositionController',
			35: 'PhidgetBLDCMotor',
			36: 'PhidgetDictionary',
			38: 'PhidgetCurrentOutput',
		};

		var PhidgetDevices = {
			'VINT': [
				{
					// DIGITALINPUT_PORT - Hub Port - Digital Input Mode
					i: 1,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "DIGITALINPUT_PORT",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// DIGITALOUTPUT_PORT - Hub Port - Digital Output Mode
					i: 2,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "DIGITALOUTPUT_PORT",
					ch: [
						{
							n: 1,
							s: 16, // PHIDCHSUBCLASS_DIGITALOUTPUT_DUTY_CYCLE
						},
					]
				},
				{
					// VOLTAGEINPUT_PORT - Hub Port - Voltage Input Mode
					i: 3,
					c: 21, // PHIDCLASS_VINT
					v: [100, 110],
					s: "VOLTAGEINPUT_PORT",
					ch: [
						{
							n: 1,
							s: 48, // PHIDCHSUBCLASS_VOLTAGEINPUT_SENSOR_PORT
						},
					]
				},
				{
					// VOLTAGEINPUT_PORT_5V25 - Hub Port - Voltage Input Mode
					i: 3,
					c: 21, // PHIDCLASS_VINT
					v: [110, 200],
					s: "VOLTAGEINPUT_PORT",
					ch: [
						{
							n: 1,
							s: 48, // PHIDCHSUBCLASS_VOLTAGEINPUT_SENSOR_PORT
						},
					]
				},
				{
					// VOLTAGERATIOINPUT_PORT - Hub Port - Voltage Ratio Mode
					i: 4,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "VOLTAGERATIOINPUT_PORT",
					ch: [
						{
							n: 1,
							s: 64, // PHIDCHSUBCLASS_VOLTAGERATIOINPUT_SENSOR_PORT
						},
					]
				},
				{
					// ADP1000 - pH Adapter Phidget
					i: 29,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "ADP1000",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// ADP1001 - Third-Party Adapter Phidget
					i: 23,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "ADP1001",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// DAQ1000 - 8x Voltage Input Phidget
					i: 50,
					c: 21, // PHIDCLASS_VINT
					v: [100, 110],
					s: "DAQ1000",
					ch: [
						{
							n: 8,
							s: 64, // PHIDCHSUBCLASS_VOLTAGERATIOINPUT_SENSOR_PORT
						},
						{
							n: 8,
							s: 48, // PHIDCHSUBCLASS_VOLTAGEINPUT_SENSOR_PORT
						},
					]
				},
				{
					// DAQ1000_5V25 - 8x Voltage Input Phidget
					i: 50,
					c: 21, // PHIDCLASS_VINT
					v: [110, 200],
					s: "DAQ1000",
					ch: [
						{
							n: 8,
							s: 64, // PHIDCHSUBCLASS_VOLTAGERATIOINPUT_SENSOR_PORT
						},
						{
							n: 8,
							s: 48, // PHIDCHSUBCLASS_VOLTAGEINPUT_SENSOR_PORT
						},
					]
				},
				{
					// OUT1000 - 12-bit Voltage Output Phidget
					i: 41,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "OUT1000",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// OUT1001 - Isolated 12-bit Voltage Output Phidget
					i: 42,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "OUT1001",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// OUT1002 - Isolated 16-bit Voltage Output Phidget
					i: 43,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "OUT1002",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// CURLOOP - 12-bit 4-20mA Output Phidget
					i: 122,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "CURLOOP",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// DAQ1200 - 4x Digital Input Phidget
					i: 28,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "DAQ1200",
					ch: [
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// OUT1100 - 4x Digital Output Phidget
					i: 25,
					c: 21, // PHIDCLASS_VINT
					v: [100, 110],
					s: "OUT1100",
					ch: [
						{
							n: 4,
							s: 16, // PHIDCHSUBCLASS_DIGITALOUTPUT_DUTY_CYCLE
						},
					]
				},
				{
					// OUT1100_Failsafe - 4x Digital Output Phidget
					i: 25,
					c: 21, // PHIDCLASS_VINT
					v: [110, 200],
					s: "OUT1100",
					ch: [
						{
							n: 4,
							s: 16, // PHIDCHSUBCLASS_DIGITALOUTPUT_DUTY_CYCLE
						},
					]
				},
				{
					// DAQ1300 - 4x Isolated Digital Input Phidget
					i: 32,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "DAQ1300",
					ch: [
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// DAQ1301 - 16x Isolated Digital Input Phidget
					i: 54,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "DAQ1301",
					ch: [
						{
							n: 16,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// DAQ1400 - Versatile Input Phidget
					i: 34,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "DAQ1400",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// DAQ1500 - Wheatstone Bridge Phidget
					i: 24,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "DAQ1500",
					ch: [
						{
							n: 2,
							s: 65, // PHIDCHSUBCLASS_VOLTAGERATIOINPUT_BRIDGE
						},
					]
				},
				{
					// VCP1100 - 30A Current Sensor Phidget
					i: 64,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "VCP1100",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// DCC1000 - DC Motor Phidget
					i: 47,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "DCC1000",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 96, // PHIDCHSUBCLASS_ENCODER_MODE_SETTABLE
						},
						{
							n: 1,
							s: 64, // PHIDCHSUBCLASS_VOLTAGERATIOINPUT_SENSOR_PORT
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// DCC1000_POSITIONCONTROL - DC Motor Phidget
					i: 47,
					c: 21, // PHIDCLASS_VINT
					v: [200, 300],
					s: "DCC1000",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 96, // PHIDCHSUBCLASS_ENCODER_MODE_SETTABLE
						},
						{
							n: 1,
							s: 64, // PHIDCHSUBCLASS_VOLTAGERATIOINPUT_SENSOR_PORT
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// DCC1001 - 2A DC Motor Phidget
					i: 68,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "DCC1001",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// DCC1002 - 4A DC Motor Phidget
					i: 70,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "DCC1002",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// DCC1003 - 2x DC Motor Phidget
					i: 73,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "DCC1003",
					ch: [
						{
							n: 2,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// DCC1100 - Brushless DC Motor Phidget
					i: 65,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "DCC1100",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// DST1000 - Distance Phidget
					i: 45,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "DST1000",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// DST1001 - Distance Phidget 650mm
					i: 121,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "VINT_DST1001",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// DST1200 - Sonar Phidget
					i: 46,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "DST1200",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// ENC1000 - Quadrature Encoder Phidget
					i: 18,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "ENC1000",
					ch: [
						{
							n: 1,
							s: 96, // PHIDCHSUBCLASS_ENCODER_MODE_SETTABLE
						},
					]
				},
				{
					// HIN1101 - Phidget Dial
					i: 67,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "HIN1101",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// HIN1000 - Touch Keypad Phidget
					i: 36,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "HIN1000",
					ch: [
						{
							n: 7,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// HIN1001 - Touch Wheel Phidget
					i: 56,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "HIN1001",
					ch: [
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// HIN1100 - Thumbstick Phidget
					i: 37,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "HIN1100",
					ch: [
						{
							n: 2,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// HUM1000 - Humidity Phidget
					i: 20,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "HUM1000",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// LCD1100 - Graphic LCD Phidget
					i: 40,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "LCD1100",
					ch: [
						{
							n: 1,
							s: 80, // PHIDCHSUBCLASS_LCD_GRAPHIC
						},
					]
				},
				{
					// LED1000 - 32x Isolated LED Phidget
					i: 39,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "LED1000",
					ch: [
						{
							n: 32,
							s: 17, // PHIDCHSUBCLASS_DIGITALOUTPUT_LED_DRIVER
						},
					]
				},
				{
					// LUX1000 - Light Phidget
					i: 33,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "LUX1000",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// MOT1100_OLD - Accelerometer Phidget
					i: 51,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "MOT1100",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// MOT1100 - Accelerometer Phidget
					i: 51,
					c: 21, // PHIDCLASS_VINT
					v: [200, 300],
					s: "MOT1100",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// MOT1101 - Spatial Phidget
					i: 52,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "MOT1101",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// PRE1000 - Barometer Phidget
					i: 17,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "PRE1000",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// RCC1000 - 16x RC Servo Phidget
					i: 49,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "RCC1000",
					ch: [
						{
							n: 16,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// REL1000 - 4x Relay Phidget
					i: 44,
					c: 21, // PHIDCLASS_VINT
					v: [100, 110],
					s: "REL1000",
					ch: [
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// REL1000_Failsafe - 4x Relay Phidget
					i: 44,
					c: 21, // PHIDCLASS_VINT
					v: [110, 200],
					s: "REL1000",
					ch: [
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// REL1100 - 4x Isolated Solid State Relay Phidget
					i: 26,
					c: 21, // PHIDCLASS_VINT
					v: [100, 110],
					s: "REL1100",
					ch: [
						{
							n: 4,
							s: 16, // PHIDCHSUBCLASS_DIGITALOUTPUT_DUTY_CYCLE
						},
					]
				},
				{
					// REL1100_Failsafe - 4x Isolated Solid State Relay Phidget
					i: 26,
					c: 21, // PHIDCLASS_VINT
					v: [110, 200],
					s: "REL1100",
					ch: [
						{
							n: 4,
							s: 16, // PHIDCHSUBCLASS_DIGITALOUTPUT_DUTY_CYCLE
						},
					]
				},
				{
					// REL1101 - 16x Isolated Solid State Relay Phidget
					i: 27,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "REL1101",
					ch: [
						{
							n: 16,
							s: 16, // PHIDCHSUBCLASS_DIGITALOUTPUT_DUTY_CYCLE
						},
					]
				},
				{
					// SAF1000 - Programmable Power Guard Phidget
					i: 38,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "SAF1000",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// SND1000 - Sound Phidget
					i: 35,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "SND1000",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// STC1000 - Stepper Phidget
					i: 48,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "STC1000",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// STC1001 - 2.5A Stepper Phidget
					i: 69,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "STC1001",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// STC1002 - 8A Stepper Phidget
					i: 71,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "STC1002",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// STC1003 - 4A Stepper Phidget
					i: 72,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "STC1003",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// TMP1000 - Temperature Phidget
					i: 19,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "TMP1000",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// TMP1100 - Isolated Thermocouple Phidget
					i: 55,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "TMP1100",
					ch: [
						{
							n: 1,
							s: 33, // PHIDCHSUBCLASS_TEMPERATURESENSOR_THERMOCOUPLE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// TMP1101 - 4x Thermocouple Phidget
					i: 21,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "TMP1101",
					ch: [
						{
							n: 4,
							s: 33, // PHIDCHSUBCLASS_TEMPERATURESENSOR_THERMOCOUPLE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// TMP1200 - RTD Phidget
					i: 16,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "TMP1200",
					ch: [
						{
							n: 1,
							s: 32, // PHIDCHSUBCLASS_TEMPERATURESENSOR_RTD
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// TMP1300 - IR Temperature Phidget
					i: 22,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "TMP1300",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// VCP1000 - 20-bit (+-40V) Voltage Input Phidget
					i: 53,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "VCP1000",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// VCP1001 - 10-bit (+-40V) Voltage Input Phidget
					i: 31,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "VCP1001",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// VCP1002 - 10-bit (+-1V) Voltage Input Phidget
					i: 30,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "VCP1002",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// FIRMWARE_UPGRADE_STM32F0 - VINT Firmware Upgrade (STM32F0)
					i: 4093,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "FIRMWARE_UPGRADE_STM32F0",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// FIRMWARE_UPGRADE_STM8S - VINT Firmware Upgrade (STM8S)
					i: 4094,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "FIRMWARE_UPGRADE_STM8S",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// GENERICVINT - Generic VINT Phidget
					i: 2457,
					c: 21, // PHIDCLASS_VINT
					v: [100, 200],
					s: "GenericVINT",
					ch: [
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
			],
			'USB': [
				{
					// IFKIT488 - PhidgetInterfaceKit 4/8/8
					i: 33281,
					c: 9, // PHIDCLASS_INTERFACEKIT
					v: [0, 101],
					s: "ifkit488",
					n: 0,
					ch: [
						{
							n: 4,
							s: 64, // PHIDCHSUBCLASS_VOLTAGERATIOINPUT_SENSOR_PORT
						},
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1000_OLD1 - PhidgetServo 1-Motor
					i: 33025,
					c: 16, // PHIDCLASS_SERVO
					v: [200, 201],
					s: "1000",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1000_OLD2 - PhidgetServo 1-Motor
					i: 57,
					c: 16, // PHIDCLASS_SERVO
					v: [200, 201],
					s: "1000",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1000_NO_ECHO - PhidgetServo 1-Motor
					i: 57,
					c: 16, // PHIDCLASS_SERVO
					v: [300, 313],
					s: "1000",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1000 - PhidgetServo 1-Motor
					i: 57,
					c: 16, // PHIDCLASS_SERVO
					v: [313, 400],
					s: "1000",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1001_OLD1 - PhidgetServo 4-Motor
					i: 33028,
					c: 16, // PHIDCLASS_SERVO
					v: [200, 201],
					s: "1001",
					n: 0,
					ch: [
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1001_OLD2 - PhidgetServo 4-Motor
					i: 56,
					c: 16, // PHIDCLASS_SERVO
					v: [200, 201],
					s: "1001",
					n: 0,
					ch: [
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1001_NO_ECHO - PhidgetServo 4-Motor
					i: 56,
					c: 16, // PHIDCLASS_SERVO
					v: [300, 313],
					s: "1001",
					n: 0,
					ch: [
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1001 - PhidgetServo 4-Motor
					i: 56,
					c: 16, // PHIDCLASS_SERVO
					v: [313, 400],
					s: "1001",
					n: 0,
					ch: [
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1002 - PhidgetAnalog 4-Output
					i: 55,
					c: 3, // PHIDCLASS_ANALOG
					v: [100, 200],
					s: "1002",
					n: 0,
					ch: [
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1008 - PhidgetAccelerometer 2-Axis
					i: 113,
					c: 1, // PHIDCLASS_ACCELEROMETER
					v: [0, 200],
					s: "1008",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1011 - PhidgetInterfaceKit 2/2/2
					i: 54,
					c: 9, // PHIDCLASS_INTERFACEKIT
					v: [0, 200],
					s: "1011",
					n: 0,
					ch: [
						{
							n: 2,
							s: 48, // PHIDCHSUBCLASS_VOLTAGEINPUT_SENSOR_PORT
						},
						{
							n: 2,
							s: 64, // PHIDCHSUBCLASS_VOLTAGERATIOINPUT_SENSOR_PORT
						},
						{
							n: 2,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 2,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1012_NO_ECHO - PhidgetInterfaceKit 0/16/16
					i: 68,
					c: 9, // PHIDCLASS_INTERFACEKIT
					v: [0, 601],
					s: "1012",
					n: 0,
					ch: [
						{
							n: 16,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 16,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1012_BITBUG - PhidgetInterfaceKit 0/16/16
					i: 68,
					c: 9, // PHIDCLASS_INTERFACEKIT
					v: [601, 602],
					s: "1012",
					n: 0,
					ch: [
						{
							n: 16,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 16,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1012 - PhidgetInterfaceKit 0/16/16
					i: 68,
					c: 9, // PHIDCLASS_INTERFACEKIT
					v: [602, 700],
					s: "1012",
					n: 0,
					ch: [
						{
							n: 16,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 16,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1013_NO_ECHO - PhidgetInterfaceKit 8/8/8
					i: 69,
					c: 9, // PHIDCLASS_INTERFACEKIT
					v: [0, 821],
					s: "1013",
					n: 0,
					ch: [
						{
							n: 8,
							s: 48, // PHIDCHSUBCLASS_VOLTAGEINPUT_SENSOR_PORT
						},
						{
							n: 8,
							s: 64, // PHIDCHSUBCLASS_VOLTAGERATIOINPUT_SENSOR_PORT
						},
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1013 - PhidgetInterfaceKit 8/8/8
					i: 69,
					c: 9, // PHIDCLASS_INTERFACEKIT
					v: [821, 900],
					s: "1013/1018/1019",
					n: 0,
					ch: [
						{
							n: 8,
							s: 48, // PHIDCHSUBCLASS_VOLTAGEINPUT_SENSOR_PORT
						},
						{
							n: 8,
							s: 64, // PHIDCHSUBCLASS_VOLTAGERATIOINPUT_SENSOR_PORT
						},
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1014_NO_ECHO - PhidgetInterfaceKit 0/0/4
					i: 64,
					c: 9, // PHIDCLASS_INTERFACEKIT
					v: [0, 704],
					s: "1014",
					n: 0,
					ch: [
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1014 - PhidgetInterfaceKit 0/0/4
					i: 64,
					c: 9, // PHIDCLASS_INTERFACEKIT
					v: [704, 800],
					s: "1014",
					n: 0,
					ch: [
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1015 - PhidgetLinearTouch
					i: 118,
					c: 9, // PHIDCLASS_INTERFACEKIT
					v: [0, 9999],
					s: "1015",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1016 - PhidgetCircularTouch
					i: 119,
					c: 9, // PHIDCLASS_INTERFACEKIT
					v: [0, 9999],
					s: "1016",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1017 - PhidgetInterfaceKit 0/0/8
					i: 129,
					c: 9, // PHIDCLASS_INTERFACEKIT
					v: [0, 9999],
					s: "1017",
					n: 0,
					ch: [
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1018 - PhidgetInterfaceKit 8/8/8
					i: 69,
					c: 9, // PHIDCLASS_INTERFACEKIT
					v: [900, 1000],
					s: "1010/1018/1019",
					n: 0,
					ch: [
						{
							n: 8,
							s: 48, // PHIDCHSUBCLASS_VOLTAGEINPUT_SENSOR_PORT
						},
						{
							n: 8,
							s: 64, // PHIDCHSUBCLASS_VOLTAGERATIOINPUT_SENSOR_PORT
						},
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1023_OLD - PhidgetRFID
					i: 48,
					c: 15, // PHIDCLASS_RFID
					v: [0, 104],
					s: "1023",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1023 - PhidgetRFID
					i: 48,
					c: 15, // PHIDCLASS_RFID
					v: [104, 200],
					s: "1023",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1023_2OUTPUT_NO_ECHO - PhidgetRFID
					i: 49,
					c: 15, // PHIDCLASS_RFID
					v: [200, 201],
					s: "1023",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1023_2OUTPUT - PhidgetRFID
					i: 49,
					c: 15, // PHIDCLASS_RFID
					v: [201, 300],
					s: "1023",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1024 - PhidgetRFID Read-Write
					i: 52,
					c: 15, // PHIDCLASS_RFID
					v: [100, 200],
					s: "1024",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1030 - PhidgetLED-64
					i: 74,
					c: 11, // PHIDCLASS_LED
					v: [100, 300],
					s: "1030",
					n: 0,
					ch: [
						{
							n: 64,
							s: 17, // PHIDCHSUBCLASS_DIGITALOUTPUT_LED_DRIVER
						},
					]
				},
				{
					// 1031 - PhidgetLED-64 Advanced
					i: 76,
					c: 11, // PHIDCLASS_LED
					v: [100, 200],
					s: "1031",
					n: 0,
					ch: [
						{
							n: 64,
							s: 17, // PHIDCHSUBCLASS_DIGITALOUTPUT_LED_DRIVER
						},
					]
				},
				{
					// 1032 - PhidgetLED-64 Advanced
					i: 76,
					c: 11, // PHIDCLASS_LED
					v: [200, 300],
					s: "1032",
					n: 0,
					ch: [
						{
							n: 64,
							s: 17, // PHIDCHSUBCLASS_DIGITALOUTPUT_LED_DRIVER
						},
					]
				},
				{
					// 1040 - PhidgetGPS
					i: 121,
					c: 7, // PHIDCLASS_GPS
					v: [0, 9999],
					s: "1040",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1041 - PhidgetSpatial 0/0/3 Basic
					i: 127,
					c: 17, // PHIDCLASS_SPATIAL
					v: [200, 300],
					s: "1041",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1042 - PhidgetSpatial 3/3/3 Basic
					i: 51,
					c: 17, // PHIDCLASS_SPATIAL
					v: [300, 400],
					s: "1042",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1043 - PhidgetSpatial Precision 0/0/3 High Resolution
					i: 127,
					c: 17, // PHIDCLASS_SPATIAL
					v: [300, 400],
					s: "1043",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1044 - PhidgetSpatial Precision 3/3/3 High Resolution
					i: 51,
					c: 17, // PHIDCLASS_SPATIAL
					v: [400, 500],
					s: "1044",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1044_1 - PhidgetSpatial Precision 3/3/3 High Resolution
					i: 51,
					c: 17, // PHIDCLASS_SPATIAL
					v: [500, 600],
					s: "1044",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1045 - PhidgetTemperatureSensor IR
					i: 60,
					c: 19, // PHIDCLASS_TEMPERATURESENSOR
					v: [100, 200],
					s: "1045",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1046_GAINBUG - PhidgetBridge 4-Input
					i: 59,
					c: 4, // PHIDCLASS_BRIDGE
					v: [100, 102],
					s: "1046",
					n: 0,
					ch: [
						{
							n: 4,
							s: 65, // PHIDCHSUBCLASS_VOLTAGERATIOINPUT_BRIDGE
						},
					]
				},
				{
					// 1046 - PhidgetBridge 4-Input
					i: 59,
					c: 4, // PHIDCLASS_BRIDGE
					v: [102, 200],
					s: "1046",
					n: 0,
					ch: [
						{
							n: 4,
							s: 65, // PHIDCHSUBCLASS_VOLTAGERATIOINPUT_BRIDGE
						},
					]
				},
				{
					// 1047 - PhidgetEncoder HighSpeed 4-Input
					i: 79,
					c: 5, // PHIDCLASS_ENCODER
					v: [100, 200],
					s: "1047",
					n: 0,
					ch: [
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1048 - PhidgetTemperatureSensor 4-Input
					i: 50,
					c: 19, // PHIDCLASS_TEMPERATURESENSOR
					v: [100, 200],
					s: "1048",
					n: 0,
					ch: [
						{
							n: 4,
							s: 33, // PHIDCHSUBCLASS_TEMPERATURESENSOR_THERMOCOUPLE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1049 - PhidgetSpatial 0/0/3
					i: 127,
					c: 17, // PHIDCLASS_SPATIAL
					v: [0, 200],
					s: "1049",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1051_OLD - PhidgetTemperatureSensor 1-Input
					i: 112,
					c: 19, // PHIDCLASS_TEMPERATURESENSOR
					v: [0, 200],
					s: "1051",
					n: 0,
					ch: [
						{
							n: 1,
							s: 33, // PHIDCHSUBCLASS_TEMPERATURESENSOR_THERMOCOUPLE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1051 - PhidgetTemperatureSensor 1-Input
					i: 112,
					c: 19, // PHIDCLASS_TEMPERATURESENSOR
					v: [200, 300],
					s: "1051",
					n: 0,
					ch: [
						{
							n: 1,
							s: 33, // PHIDCHSUBCLASS_TEMPERATURESENSOR_THERMOCOUPLE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1051_AD22100 - PhidgetTemperatureSensor 1-Input
					i: 112,
					c: 19, // PHIDCLASS_TEMPERATURESENSOR
					v: [300, 400],
					s: "1051",
					n: 0,
					ch: [
						{
							n: 1,
							s: 33, // PHIDCHSUBCLASS_TEMPERATURESENSOR_THERMOCOUPLE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1051_TERMINAL_BLOCKS - PhidgetTemperatureSensor 1-Input
					i: 112,
					c: 19, // PHIDCLASS_TEMPERATURESENSOR
					v: [400, 500],
					s: "1051",
					n: 0,
					ch: [
						{
							n: 1,
							s: 33, // PHIDCHSUBCLASS_TEMPERATURESENSOR_THERMOCOUPLE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1052_OLD - PhidgetEncoder
					i: 75,
					c: 5, // PHIDCLASS_ENCODER
					v: [0, 101],
					s: "1052",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1052_v1 - PhidgetEncoder
					i: 75,
					c: 5, // PHIDCLASS_ENCODER
					v: [101, 110],
					s: "1052",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1052_v2 - PhidgetEncoder
					i: 75,
					c: 5, // PHIDCLASS_ENCODER
					v: [110, 300],
					s: "1052",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1053 - PhidgetAccelerometer 2-Axis
					i: 113,
					c: 1, // PHIDCLASS_ACCELEROMETER
					v: [300, 400],
					s: "1053",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1054 - PhidgetFrequencyCounter
					i: 53,
					c: 6, // PHIDCLASS_FREQUENCYCOUNTER
					v: [0, 200],
					s: "1054",
					n: 0,
					ch: [
						{
							n: 2,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1055 - PhidgetIR
					i: 77,
					c: 10, // PHIDCLASS_IR
					v: [100, 200],
					s: "1055",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1056 - PhidgetSpatial 3/3/3
					i: 51,
					c: 17, // PHIDCLASS_SPATIAL
					v: [0, 200],
					s: "1056",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1056_NEG_GAIN - PhidgetSpatial 3/3/3
					i: 51,
					c: 17, // PHIDCLASS_SPATIAL
					v: [200, 300],
					s: "1056",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1057 - PhidgetEncoder HighSpeed
					i: 128,
					c: 5, // PHIDCLASS_ENCODER
					v: [300, 400],
					s: "1057",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1058 - PhidgetPHSensor
					i: 116,
					c: 14, // PHIDCLASS_PHSENSOR
					v: [100, 200],
					s: "1058",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1059 - PhidgetAccelerometer 3-Axis
					i: 126,
					c: 1, // PHIDCLASS_ACCELEROMETER
					v: [400, 500],
					s: "1059",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1060 - PhidgetMotorControl LV
					i: 88,
					c: 13, // PHIDCLASS_MOTORCONTROL
					v: [100, 200],
					s: "1060",
					n: 0,
					ch: [
						{
							n: 2,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1061 - PhidgetAdvancedServo 8-Motor
					i: 58,
					c: 2, // PHIDCLASS_ADVANCEDSERVO
					v: [100, 200],
					s: "1061",
					n: 0,
					ch: [
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1061_PGOOD_FLAG - PhidgetAdvancedServo 8-Motor
					i: 58,
					c: 2, // PHIDCLASS_ADVANCEDSERVO
					v: [200, 300],
					s: "1061",
					n: 0,
					ch: [
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1061_CURSENSE_FIX - PhidgetAdvancedServo 8-Motor
					i: 58,
					c: 2, // PHIDCLASS_ADVANCEDSERVO
					v: [300, 400],
					s: "1061",
					n: 0,
					ch: [
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// RCC0004 - PhidgetAdvancedServo 8-Motor
					i: 58,
					c: 2, // PHIDCLASS_ADVANCEDSERVO
					v: [400, 500],
					s: "RCC0004",
					n: 0,
					ch: [
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1062 - PhidgetStepper Unipolar 4-Motor
					i: 122,
					c: 18, // PHIDCLASS_STEPPER
					v: [100, 200],
					s: "1062",
					n: 0,
					ch: [
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1063 - PhidgetStepper Bipolar 1-Motor
					i: 123,
					c: 18, // PHIDCLASS_STEPPER
					v: [100, 200],
					s: "1063",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1064 - PhidgetMotorControl HC
					i: 89,
					c: 13, // PHIDCLASS_MOTORCONTROL
					v: [100, 200],
					s: "1064",
					n: 0,
					ch: [
						{
							n: 2,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 2,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1065 - PhidgetMotorControl 1-Motor
					i: 62,
					c: 13, // PHIDCLASS_MOTORCONTROL
					v: [100, 200],
					s: "1065",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 2,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 2,
							s: 48, // PHIDCHSUBCLASS_VOLTAGEINPUT_SENSOR_PORT
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 2,
							s: 64, // PHIDCHSUBCLASS_VOLTAGERATIOINPUT_SENSOR_PORT
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1066 - PhidgetAdvancedServo 1-Motor
					i: 130,
					c: 2, // PHIDCLASS_ADVANCEDSERVO
					v: [100, 200],
					s: "1066",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1067 - PhidgetStepper Bipolar HC
					i: 123,
					c: 18, // PHIDCLASS_STEPPER
					v: [200, 300],
					s: "1067",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1202_IFKIT_NO_ECHO - PhidgetInterfaceKit 8/8/8
					i: 125,
					c: 9, // PHIDCLASS_INTERFACEKIT
					v: [0, 120],
					s: "1202/1203",
					n: 0,
					ch: [
						{
							n: 8,
							s: 48, // PHIDCHSUBCLASS_VOLTAGEINPUT_SENSOR_PORT
						},
						{
							n: 8,
							s: 64, // PHIDCHSUBCLASS_VOLTAGERATIOINPUT_SENSOR_PORT
						},
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1202_IFKIT - PhidgetInterfaceKit 8/8/8
					i: 125,
					c: 9, // PHIDCLASS_INTERFACEKIT
					v: [120, 200],
					s: "1202/1203",
					n: 0,
					ch: [
						{
							n: 8,
							s: 48, // PHIDCHSUBCLASS_VOLTAGEINPUT_SENSOR_PORT
						},
						{
							n: 8,
							s: 64, // PHIDCHSUBCLASS_VOLTAGERATIOINPUT_SENSOR_PORT
						},
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1202_TEXTLCD - PhidgetTextLCD 20X2
					i: 125,
					c: 20, // PHIDCLASS_TEXTLCD
					v: [0, 200],
					s: "1202/1203",
					n: 1,
					ch: [
						{
							n: 1,
							s: 81, // PHIDCHSUBCLASS_LCD_TEXT
						},
					]
				},
				{
					// 1202_IFKIT_FAST - PhidgetInterfaceKit 8/8/8
					i: 125,
					c: 9, // PHIDCLASS_INTERFACEKIT
					v: [200, 300],
					s: "1202/1203",
					n: 0,
					ch: [
						{
							n: 8,
							s: 48, // PHIDCHSUBCLASS_VOLTAGEINPUT_SENSOR_PORT
						},
						{
							n: 8,
							s: 64, // PHIDCHSUBCLASS_VOLTAGERATIOINPUT_SENSOR_PORT
						},
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// 1202_TEXTLCD_BRIGHTNESS - PhidgetTextLCD 20X2
					i: 125,
					c: 20, // PHIDCLASS_TEXTLCD
					v: [200, 9999],
					s: "1202/1203",
					n: 1,
					ch: [
						{
							n: 1,
							s: 81, // PHIDCHSUBCLASS_LCD_TEXT
						},
					]
				},
				{
					// 1204 - PhidgetTextLCD Adapter
					i: 61,
					c: 20, // PHIDCLASS_TEXTLCD
					v: [0, 9999],
					s: "1204",
					n: 0,
					ch: [
						{
							n: 2,
							s: 81, // PHIDCHSUBCLASS_LCD_TEXT
						},
					]
				},
				{
					// 1215 - PhidgetTextLCD 20X2
					i: 82,
					c: 20, // PHIDCLASS_TEXTLCD
					v: [0, 9999],
					s: "1215/1216/1217/1218",
					n: 0,
					ch: [
						{
							n: 1,
							s: 81, // PHIDCHSUBCLASS_LCD_TEXT
						},
					]
				},
				{
					// 1219 - PhidgetTextLCD 20X2 with InterfaceKit 0/8/8
					i: 83,
					c: 20, // PHIDCLASS_TEXTLCD
					v: [0, 9999],
					s: "1219/1220/1221/1222",
					n: 0,
					ch: [
						{
							n: 1,
							s: 81, // PHIDCHSUBCLASS_LCD_TEXT
						},
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 8,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// HUB0000 - 6-Port USB VINT Hub Phidget
					i: 63,
					c: 8, // PHIDCLASS_HUB
					v: [100, 200],
					s: "HUB0000",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// HUB0002 - Wireless VINT Dongle Phidget
					i: 65,
					c: 12, // PHIDCLASS_MESHDONGLE
					v: [100, 200],
					s: "HUB0002",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// HUB5000 - 6-Port Network VINT Hub Phidget
					i: 66,
					c: 8, // PHIDCLASS_HUB
					v: [100, 200],
					s: "HUB5000",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// FIRMWARE_UPGRADE_M3_USB - USB Firmware Upgrade (M3)
					i: 152,
					c: 23, // PHIDCLASS_FIRMWAREUPGRADE
					v: [0, 9999],
					s: "FIRMWARE_UPGRADE_M3",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// GENERIC - Generic USB Phidget
					i: 153,
					c: 22, // PHIDCLASS_GENERIC
					v: [0, 9999],
					s: "GenericDevice",
					n: 0,
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// USBSWITCH - OS Testing Fixture v1.1
					i: 154,
					c: 9, // PHIDCLASS_INTERFACEKIT
					v: [100, 200],
					s: "USBSWITCH",
					n: 0,
					ch: [
						{
							n: 2,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 2,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 2,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 2,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
						{
							n: 4,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// TEXTLED_4x8 - PhidgetTextLED 4x8
					i: 72,
					c: 22, // PHIDCLASS_GENERIC
					v: [0, 0],
					s: "textled4x8",
					n: 0,
					ch: [
					]
				},
				{
					// TEXTLED_1x8 - PhidgetTextLED 1x8
					i: 73,
					c: 22, // PHIDCLASS_GENERIC
					v: [0, 0],
					s: "textled1x8",
					n: 0,
					ch: [
					]
				},
				{
					// INTERFACEKIT_2_8_8 - PhidgetInterfaceKit 2/8/8
					i: 33280,
					c: 22, // PHIDCLASS_GENERIC
					v: [0, 0],
					s: "ifkit288",
					n: 0,
					ch: [
					]
				},
				{
					// POWER - PhidgetPower
					i: 34048,
					c: 22, // PHIDCLASS_GENERIC
					v: [0, 0],
					s: "power",
					n: 0,
					ch: [
					]
				},
				{
					// INTERFACEKIT_0_5_7_LCD - PhidgetInterfaceKit 0/5/7 with TextLCD
					i: 81,
					c: 22, // PHIDCLASS_GENERIC
					v: [0, 0],
					s: "ifkit057",
					n: 0,
					ch: [
					]
				},
				{
					// INTERFACEKIT_0_32_32 - PhidgetInterfaceKit 0/32/32
					i: 96,
					c: 22, // PHIDCLASS_GENERIC
					v: [0, 0],
					s: "ifkit3232",
					n: 0,
					ch: [
					]
				},
				{
					// WEIGHTSENSOR - PhidgetWeightSensor
					i: 114,
					c: 22, // PHIDCLASS_GENERIC
					v: [0, 0],
					s: "1050",
					n: 0,
					ch: [
					]
				},
			],
			'MESH': [
				{
					// HUB0001 - 4-Port Wireless VINT Hub Phidget
					i: 1,
					c: 8, // PHIDCLASS_HUB
					v: [100, 200],
					s: "HUB0001",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
			],
			'SPI': [
				{
					// HUB0004 - 6-Port PhidgetSBC VINT Hub Phidget
					i: 1,
					c: 8, // PHIDCLASS_HUB
					v: [100, 200],
					s: "HUB0004",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
				{
					// FIRMWARE_UPGRADE_M3_SPI - SPI Firmware Upgrade (M3)
					i: 2,
					c: 23, // PHIDCLASS_FIRMWAREUPGRADE
					v: [0, 9999],
					s: "FIRMWARE_UPGRADE_M3",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
			],
			'LIGHTNING': [
				{
					// HUB0005 - 6-Port Lighting VINT Hub Phidget
					i: 66,
					c: 8, // PHIDCLASS_HUB
					v: [100, 200],
					s: "HUB0005",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
			],
			'VIRTUAL': [
				{
					// DICTIONARY - Dictionary
					i: 0,
					c: 24, // PHIDCLASS_DICTIONARY
					v: [100, 200],
					s: "Dictionary",
					ch: [
						{
							n: 1,
							s: 1, // PHIDCHSUBCLASS_NONE
						},
					]
				},
			],
		};


		/**************************************************************************************************
		 * Device
		 */

		function findPhidgetDevice(data) {

			var typeDevs = PhidgetDevices[data.type];
			for (var d in typeDevs) {
				d = typeDevs[d];
				if (d.v[0] > data.version || d.v[1] <= data.version)
					continue;
				if (data.type === 'VINT') {
					if (d.i !== data.vintID)
						continue;
				} else {
					if (d.i !== data.productID)
						continue;
					if (d.n !== undefined && d.n != data.interfaceNum)
						continue;
				}
				return d;
			}
			throw (new PhidgetError(ErrorCode.UNEXPECTED, "Couldn't find device in device list!!"));
		}

		var Device = function (conn, data) {

			this.conn = conn;

			this.type = data.type;
			this.phid = data.phid;
			this.parent = conn.getDevice(data.parent);
			this.pphid = data.parent;
			this.vendorID = data.vendorID;
			this.productID = data.productID;
			this.deviceID = data.deviceID;
			this.serialNumber = data.serialNumber;
			this.label = data.label;
			this.version = data.version;
			this.interfaceNum = data.interfaceNum;
			this.index = data.index;
			this.hubPort = data.hubPort;
			this.isHubPort = data.isHubPort !== 0;
			this.desc = data.desc;
			this.name = data.name;
			this.fwstr = data.fwstr;

			if (this.type === 'VINT')
				this.vintID = data.vintID;

			this.phiddev = findPhidgetDevice(data);
			this.class = this.phiddev.c;
			this.sku = this.phiddev.s;
		}

		Device.prototype.toString = function () {

			return ('DEV[' + this.pphid + '/' + this.phid + '] ' + this.name);
		}

		/**************************************************************************************************
		 * Channel
		 */

		function findPhidgetChannel(dev, data) {

			var index = 0;
			for (var c in dev.phiddev.ch) {
				c = dev.phiddev.ch[c];
				if (data.uniqueIndex < index + c.n) {
					return c;
				}
				index += c.n;
			}
			throw (new PhidgetError(ErrorCode.UNEXPECTED, "Couldn't find channel in channel list!!"));
		}

		var Channel = function (conn, dev, data) {

			var self = this;

			this.listeners = [];

			this.conn = conn;
			this.isopen = false;

			this.isHubPort = dev.isHubPort;

			this.parent = dev;
			this.chid = data.chid;
			this.name = data.name;
			this.channelname = data.channelname;
			if (this.channelname.startsWith('Phidget'))
				this.cname = this.channelname.substring(7);
			else
				this.cname = this.channelname;
			this.class = data.class;
			this.uniqueIndex = data.uniqueIndex;
			this.index = data.index;
			this.cpversion = data.version;	/* communication proto version, not device version! */

			this.phidch = findPhidgetChannel(dev, data);
			this.subclass = this.phidch.subcls;
		}

		Channel.prototype.match = function (phid) {

			if (phid.class !== this.class)
				return (false);

			if (phid._serialNumber != undefined && phid._serialNumber !== -1) {
				if (phid._serialNumber != this.parent.serialNumber)
					return (false);
			}

			if (phid._channel != undefined && phid._channel !== -1) {
				if (phid._channel != this.index)
					return (false);
			}

			if (phid._hubPort != undefined && phid._hubPort !== -1) {
				if (phid._hubPort != this.parent.hubPort)
					return (false);
			}

			if (phid._isHubPort !== undefined) {
				if (phid._isHubPort !== this.isHubPort)
					return (false);
			}

			if (phid._deviceLabel !== undefined && phid._deviceLabel !== null) {
				if (phid._deviceLabel !== this.parent.label)
					return (false);
			}

			debug("matched:" + phid + " -> " + this);
			return (true);
		}

		Channel.prototype.onDetach = function () {

			if (this.isopen) {
				/*
				 * Flag that we are closing because of a device detach.
				 * This prevents Channel.close() from executing against a detached device.
				 */
				this.detaching = true;
				this.userphid._close(this.userphid);

				this.isopen = false;
				delete this.userphid;
				delete this.detaching;
			}
		}

		Channel.prototype.closing = function (phid) {

			if (!this.isopen)
				return;
			if (this.userphid !== phid)
				return;

			this.userphid.isopen = false;
			delete ch.userphid.channel;

			ch.isopen = false;
			delete ch.userphid;
		}

		Channel.prototype.open = function (phid) {

			var self = this;

			phid.attaching = true;

			var json = JSON.stringify({
				phid: this.parent.phid,
				channel: this.chid,
				class: this.class,
				index: this.uniqueIndex,
				version: this.cpversion
			});

			return (new Promise(function (resolve, reject) {
				self.conn.sendRequest(0, 0, 0, P22MSG.Device, P22SMSG.Open, json).then(function (status) {
					phid.attaching = false;
					self.isopen = true;
					self.userphid = phid;

					/* deliver the status data */
					var bp = new BridgePacket(self.conn, null, status);
					try {
						bp.deliver();
					} catch (e) {
						reject(e);
						return;
					}

					phid.wasOpened(self);
					resolve();
				}).catch(function (err) {
					reject(err);
				});
			}));
		}

		/*
		 * Currently only expected to be called from Phidget.close().
		 * We do not notify the Phidget.
		 */
		Channel.prototype.close = function () {

			if (this.detaching)
				return (Promise.resolve());

			var json = JSON.stringify({
				phid: this.parent.phid,
				index: this.uniqueIndex,
			});

			return (this.conn.sendRequest(0, 0, 0, P22MSG.Device, P22SMSG.Close, json));
		}

		Channel.prototype.toString = function () {

			return ('CH[' + this.parent.phid + '/' + this.cname + '(' + this.index + ')] ' + this.name);
		}

		/**************************************************************************************************
		 * Phidget
		 *  Combines a Channel/Device into a logical Phidget
		 */
		var Phidget = function Phidget(channel, device) {

			var self = this;
			this.name = 'Phidget';	/* should be updated by actual implementation of a class */

			this._isHubPort = false;	/* do not open hub ports by default */

			this.id = UserPhidgetID++;

			this.attaching = false;	/* in the process of being attached to a server channel */
			this.useropen = false;	/* user called open: registered to attached to a channel */
			this.isopen = false;	/* user opened, and attached to a channel */
			this.isattached = false;
			this.detaching = false;

			if (channel)
				this.channel = channel;
			if (device)
				this.device = device;
			if (channel && !device)
				this.device = channel.parent;

			if (device && !channel)
				this.isChannel = false;
			else
				this.isChannel = true;

			this.manager = false;
			if (channel || device) {
				this.manager = true;
				this.isattached = true;
			}

			this.onAttach = function (phid) { };
			this.onDetach = function (phid) { };

			this.wasOpened = function (ch) {

				self.channel = ch;
				self.device = ch.parent;
				self.isopen = true;
				self.isattached = true;
				self.onopen(self);
			}
		}
		Phidget.prototype.constructor = Phidget;

		self.ANY_SERIAL_NUMBER = -1;
		self.ANY_HUB_PORT = -1;
		self.ANY_CHANNEL = -1;
		self.ANY_LABEL = null;
		self.INFINITE_TIMEOUT = 0;
		self.DEFAULT_TIMEOUT = 2500;

		Phidget.prototype.openTimedOut = function () {

			this.onclose(ErrorCode.TIMEOUT, "Open timed out");
			this.close();
		}

		Phidget.prototype._close = function () {

			if (this.isopen)
				var closePromise = this.channel.close();

			delete this.openTimeout;
			delete this.openTime;

			/*
			 * If we are called because the device is detaching, do not deregister, and
			 * flag as user opened.
			 */
			if (this.channel != undefined && !this.channel.detaching) {
				if (this.id in UserPhidgets)
					delete UserPhidgets[this.id];
			} else {
				this.useropen = true;
			}

			if (this.isopen) {
				this.detaching = true;
				this.isattached = false;
				this.onDetach(this);
				this.detaching = false;
				this.isopen = false;
				delete this.channel;
				delete this.device;
			} else {
				this.onclose(ErrorCode.CLOSED, "Closed while waiting for open");
			}

			if (typeof closePromise !== 'undefined')
				return (closePromise);
			return (Promise.resolve());
		}

		Phidget.prototype.handleSetStatus = function (bp, version) {

			if (!('data' in this))
				this['data'] = {};

			for (var e in bp.entries)
				this.data[e] = bp.entries[e].v;

			if (this.data['_class_version_'] !== version)
				throw (new PhidgetError(ErrorCode.BAD_VERSION, this.name + ' version (' + this.data['_class_version_'] +
					') does not match (' + version + ')'));
		}

		Phidget.prototype.checkAttached = function () {

			if (!this.isattached && !this.detaching)
				throw (new PhidgetError(ErrorCode.NOT_ATTACHED));
		}

		Phidget.prototype.checkOpen = function () {


			if (!this.isopen)
				throw (new PhidgetError(ErrorCode.NOT_ATTACHED));
		}

		Phidget.prototype.checkIsChannel = function () {

			if (!this.isChannel)
				throw (new PhidgetError(ErrorCode.UNSUPPORTED));
		}

		/******************************
		 *******  Phidget API  ********
		 ******************************/

		Phidget.prototype.getKey = function () {

			this.checkAttached();
			if (this.isChannel)
				return 'ch' + this.channel.chid;
			else
				return 'dev' + this.device.phid;
		}

		Phidget.prototype.open = function (_timeout) {

			var self = this;

			if (this.useropen)
				return (Promise.resolve(this));

			// Can't open a manager device
			if (!this.isChannel)
				return (Promise.reject(new PhidgetError(ErrorCode.UNSUPPORTED)));

			// Open a channel from the manager
			if (this.manager === true) {
				this.setChannel(this.getChannel());
				this.setHubPort(this.getHubPort());
				this.setDeviceSerialNumber(this.getDeviceSerialNumber());
				this.setIsHubPortDevice(this.getIsHubPortDevice());
				this.manager = false;
			}

			if (_timeout) {
				var timeout = parseInt(_timeout);
				if (!isNaN(timeout))
					this.openTimeout = timeout;
			}

			UserPhidgets[this.id] = this;
			this.useropen = true;
			this.openTime = tm();
			scanChannels(this);

			return (new Promise(function (resolve, reject) {
				self.onopen = function () {
					self.onAttach(self);
					resolve(self);
				};
				self.onclose = function (code, msg) {
					reject(new PhidgetError(code, msg));
				};
			}));
		}

		Phidget.prototype.close = function () {

			debug("closing phidget");
			this.useropen = false;

			return (this._close());
		}

		Phidget.prototype.getAttached = function () {

			return (this.isattached);
		}

		Phidget.prototype.getChannel = function () {

			this.checkIsChannel();

			if (!this.isattached && !this.detaching)
				return (this._channel);

			return (this.channel.index);
		}

		Phidget.prototype.setChannel = function (ch) {

			this.checkIsChannel();

			ch = parseInt(ch);
			if (!isNaN(ch))
				this._channel = ch;
		}

		Phidget.prototype.getChannelClass = function () {

			this.checkIsChannel();
			this.checkAttached();

			return (this.channel.class);
		}

		Phidget.prototype.getChannelClassName = function () {

			this.checkIsChannel();
			this.checkAttached();

			return (ChannelClassName[this.channel.class]);
		}

		Phidget.prototype.getChannelName = function () {

			this.checkIsChannel();
			this.checkAttached();

			return (this.channel.name);
		}

		Phidget.prototype.getChannelSubclass = function () {

			this.checkIsChannel();
			this.checkAttached();

			return (this.channel.subclass);
		}

		Phidget.prototype.getDeviceClass = function () {

			this.checkAttached();

			return (this.device.class);
		}

		Phidget.prototype.getDeviceClassName = function () {

			this.checkAttached();

			return (DeviceClassName[this.device.class]);
		}

		Phidget.prototype.getDeviceID = function () {

			this.checkAttached();

			return (this.device.deviceID);
		}

		Phidget.prototype.getDeviceLabel = function () {

			if (!this.isattached && !this.detaching) {
				this.checkIsChannel();
				return (this._deviceLabel ? this._deviceLabel : '');
			}

			return (this.device.label);
		}

		Phidget.prototype.setDeviceLabel = function (label) {

			this.checkIsChannel();

			this._deviceLabel = label;
		}

		Phidget.prototype.getDeviceName = function () {

			this.checkAttached();

			return (this.device.name);
		}

		Phidget.prototype.getDeviceSerialNumber = function () {

			if (!this.isattached && !this.detaching) {
				this.checkIsChannel();
				return (this._serialNumber);
			}

			return (this.device.serialNumber);
		}

		Phidget.prototype.setDeviceSerialNumber = function (sn) {

			this.checkIsChannel();

			sn = parseInt(sn);
			if (!isNaN(sn))
				this._serialNumber = sn;
		}

		Phidget.prototype.getDeviceSKU = function () {

			this.checkAttached();

			return (this.device.sku);
		}

		Phidget.prototype.getDeviceVersion = function () {

			this.checkAttached();

			return (this.device.version);
		}

		Phidget.prototype.getHub = function () {

			this.checkAttached();

			var parent = this.device;
			while (parent !== undefined && parent.class !== DeviceClass.HUB)
				parent = parent.parent;

			if (!parent)
				return undefined;

			return (new Phidget(null, parent));
		}

		Phidget.prototype.getHubPort = function () {

			if (!this.isattached && !this.detaching) {
				this.checkIsChannel();
				return (this._hubPort);
			}

			return (this.device.hubPort);
		}

		Phidget.prototype.setHubPort = function (hubPort) {

			this.checkIsChannel();

			hubPort = parseInt(hubPort);
			if (!isNaN(hubPort))
				this._hubPort = hubPort;
		}

		Phidget.prototype.getIsChannel = function () {

			return (this.isChannel);
		}

		Phidget.prototype.getIsHubPortDevice = function () {

			if (!this.isattached && !this.detaching) {
				this.checkIsChannel();
				return (this._isHubPort);
			}

			return (this.device.isHubPort);
		}

		Phidget.prototype.setIsHubPortDevice = function (isHubPort) {

			this.checkIsChannel();

			this._isHubPort = !!isHubPort;
		}

		Phidget.prototype.getParent = function () {

			this.checkAttached();

			if (this.isChannel)
				var parent = this.channel.parent;
			else
				var parent = this.device.parent;

			if (!parent)
				return undefined;

			return (new Phidget(null, parent));
		}

		Phidget.prototype.getDeviceDeviceVINTID = function () {

			this.checkAttached();

			return (this.device.vintID);
		}

		Phidget.prototype.getDeviceFirmwareUpgradeString = function () {

			this.checkAttached();

			switch (this.device.type) {
				case 'USB':
				case 'SPI':
					return this.device.fwstr;
				case 'VINT':
				case 'MESH':
				case 'LIGHTNING':
				case 'VIRTUAL':
					return this.device.sku;
			}
		}

		Phidget.prototype.writeDeviceLabel = function (deviceLabel) {

			this.checkIsChannel();
			this.checkAttached();

			var self = this;
			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "s", value: deviceLabel });
			return (bp.send(this.channel, BridgePackets.BP_WRITELABEL).then(function (res) {
				self.device.label = deviceLabel;
				return res;
			}));
		};

		Phidget.prototype.toString = function () {

			return (this.name);
		}

		// Export
		self.Phidget = Phidget;

		/**************************************************************************************************
		 * Manager
		 */
		var Manager = function (cfg) {

			this.isopen = false;

			this.id = ManagerID++;
			Managers[this.id] = this;

			this.onDeviceAttach = function (dev) { };
			this.onDeviceDetach = function (dev) { };
			this.onAttach = function (ch) { };
			this.onDetach = function (ch) { };

			if (cfg) {
				if ('onDeviceAttach' in cfg && typeof cfg.onDeviceAttach === 'function')
					this.onDeviceAttach = cfg.onDeviceAttach;
				if ('onDeviceDetach' in cfg && typeof cfg.onDeviceDetach === 'function')
					this.onDeviceDetach = cfg.onDeviceDetach;
				if ('onAttach' in cfg && typeof cfg.onAttach === 'function')
					this.onAttach = cfg.onAttach;
				if ('onDetach' in cfg && typeof cfg.onDetach === 'function')
					this.onDetach = cfg.onDetach;
			}
		}

		Manager.prototype.delete = function () {

			delete Managers[this.id];
		}

		Manager.prototype.open = function () {

			if (this.isopen)
				return;

			for (var conn in Connections) {
				conn = Connections[conn];
				for (var d in conn.Devices) {
					d = conn.Devices[d];
					var phid = new Phidget(null, d);
					this.onDeviceAttach(phid);
				}

				for (var c in conn.Channels) {
					c = conn.Channels[c]
					var cons = getPhidgetConstructor(c.class)
					var phid = new cons(c);
					this.onAttach(phid);
				}
			}

			this.isopen = true;
		}

		Manager.prototype.close = function () {

			this.isopen = false;
		}

		// Export
		self.Manager = Manager;

		/**************************************************************************************************
		 * Connection
		 */

		/* internal functions */

		/*
		 * WebSocket onmessage
		 */
		var Connection_ws_onmessage = function (event) {

			this.onmessage(event.data);
		}

		/* NodeJS socket onmessage
		 *
		 * Receives data from the socket and processes it.
		 *
		 * The server writes data faster than we can read it a lot of times, and these need to be handled
		 * in order, so there doesn't seem to be a good (easy) way to not block everything while packets
		 * are being processed.  If this does turn out to be a problem, we could pack the data into the
		 * request object, and make an array of those to be fired by setTimer(x, 0).
		 */
		var Connection_sock_onmessage = function(data) {

			var HDRLEN = 16;

			var len = data.length;
			var wdata = data;

			if (this.sockdatalen > 0) {
				var bufs = [this.sockdata, wdata];
				wdata = Buffer.concat(bufs, this.sockdata.length + wdata.length);
				this.sockdata = null;
				this.sockdatalen = 0;
				len = wdata.length;
			}

			if (len >= HDRLEN) {
				do {
					var req = new Request(wdata);

					/*
					 * Short circuit if the length matches exactly.
					 */
					if (len === req.len + HDRLEN) {
						this.onmessage(wdata, req);
						return;
					}

					/*
					 * The payload isn't here yet.
					 */
					if (len < req.len + HDRLEN)
						break;

					/*
					 * We've got more than enough data.
					 */
					var d = wdata.slice(0, req.len + HDRLEN);
					wdata = wdata.slice(req.len + HDRLEN);
					len -= d.length;

					this.onmessage(d, req);
				} while (len >= HDRLEN);
			}

			if (len > 0) {
				this.sockdata = wdata;
				this.sockdatalen = wdata.length;
			}
		}

		/*
		* Support multiple constructor signatures:
		*   Connection([options])
		*   Connection(uri[, options])
		*   Connection(port[, hostname][, options])
		*/
		var Connection = function (arg1, arg2, arg3) {

			if (arg1 !== undefined && arg1 !== null && typeof arg1 === 'object')
				var options = arg1;

			if (arg1 !== undefined && arg1 !== null && typeof arg1 === 'string') {
				this.uri = arg1;

				if (isNode) {
					var u = url.parse(this.uri);
					if (u.protocol === 'ws:')
						throw ('websocket not supported with node.js, use "phid://server:port"');
					if (u.protocol !== 'phid:')
						throw ('expected phidget protocol, use "phid://server:port"');
					this.hostname = u.hostname;
					this.port = u.port;
				} else {
					this.hostname = 'uri';
					this.port = 'uri';
				}

				if (arg2 !== undefined && arg2 !== null && typeof arg2 === 'object')
					var options = arg2;
			}

			if (arg1 !== undefined && arg1 !== null && typeof arg1 === 'number') {
				this.port = arg1;
				if (arg2 !== undefined && arg2 !== null && typeof arg2 === 'string') {
					this.hostname = arg2;
					if (arg3 !== undefined && arg3 !== null && typeof arg3 === 'object')
						var options = arg3;
				}
			}

			this.id = ConnectionID++;
			Connections[this.id] = this;

			this.generation = 0;

			this.TIMEOUT = 5000;

			this.connected = false;	/* currently connected */
			this.stayopen = false;	/* want to be connected */

			this.websocket = false;
			this.ws = null;
			this.sock = null;
			this.sockdata = null;
			this.sockdatalen = 0;
			this.nonceC = null;
			this.passwd = '';

			this.Channels = {};
			this.Devices = {};		/* O(1) access -- as far as we are concerned */
			this.DeviceList = [];	/* maintain order discovered */

			this.reqseq = 10;		/* request sequence counter */
			this.requests = {};		/* outstanding requests */

			this.oChannel = null;	/* channel being opened */
			this.cChannel = null;	/* channel being closed */

			this.onError = function (code, msg) {
				console.error("Connection error: " + msg + ':0x' + code.toString(16));
			}
			this.onAuthenticationNeeded = function () {
				console.log("A password is required for this server. Handle the onAuthenticationNeeded event to return a password.");
			}
			this.onConnect = function () { }
			this.onDisconnect = function () { }

			/*
			 * Handle user config after basic setup.
			 */
			if (options !== undefined) {

				if (options.hostname && this.hostname === undefined)
					this.hostname = options.hostname;

				if (options.port && this.port === undefined) {
					if (typeof options.port === 'number')
						this.port = options.port;
					if (typeof options.port === 'string')
						this.port = Number(options.port);
				}

				if (options.name)
					this.name = options.name;

				if (options.onConnect && typeof options.onConnect === 'function')
					this.onConnect = options.onConnect;

				if (options.onDisconnect && typeof options.onDisconnect === 'function')
					this.onDisconnect = options.onDisconnect;

				if (options.onAuthenticationNeeded && typeof options.onAuthenticationNeeded === 'function')
					this.onAuthenticationNeeded = options.onAuthenticationNeeded;

				if (options.onError && typeof options.onError === 'function')
					this.onError = options.onError;

				if (options.passwd)
					this.passwd = options.passwd;
			}

			// Defaults
			if (this.hostname === undefined)
				this.hostname = 'localhost';
			if (this.port === undefined)
				this.port = isNode ? 5661 : 8989;

			if (this.uri === undefined) {
				if (isNode)
					this.uri = 'phid://' + this.hostname + ':' + this.port;
				else
					this.uri = 'ws://' + this.hostname + ':' + this.port + '/phidgets';
			}

			if (this.name === undefined)
				this.name = this.uri;

			this.onattach = function (dev) {

				var phid = new Phidget(null, dev);

				for (var m in Managers)
					if (Managers[m].isopen)
						Managers[m].onDeviceAttach(phid);
			}

			this.ondetach = function (dev) {

				var phid = new Phidget(null, dev);

				for (var m in Managers)
					if (Managers[m].isopen)
						Managers[m].onDeviceDetach(phid);
			}

			this.onchannelattach = function (ch) {

				var cons = getPhidgetConstructor(ch.class);
				var phid = new cons(ch);

				for (var m in Managers)
					if (Managers[m].isopen)
						Managers[m].onAttach(phid);

				/*
				 * Determine if any user phidgets match this new channel.
				 */
				scanUserPhidgets(ch);
			}

			this.onchanneldetach = function (ch) {

				var cons = new getPhidgetConstructor(ch.class);
				var phid = new cons(ch);

				for (var m in Managers)
					if (Managers[m].isopen)
						Managers[m].onDetach(phid);

				ch.onDetach();
			}

			this.matchPhidget = function (phid) {

				for (var c in this.Channels) {
					if (this.Channels[c].match(phid)) {
						this.Channels[c].open(phid).catch(function (err) {
							if (this.onError)
								this.onError(err.errorCode, err.message);
							else
								console.error(err);
						}.bind(phid));
						return (true);
					}
				}
				return (false);
			}

			this.onevent = function (event) { debug("event:" + event); }

			/*
			 * Creates the request if necessary, and routes the message to the correct handler.
			 */
			this.onmessage = function (data, req) {

				var array = new Uint8Array(data);

				if (!req)
					req = new Request(array);

				if (req.len > 0) {
					if (isNode)
						var tmp1 = data.slice(req.hdrlen);
					else
						var tmp1 = new Uint8Array(array.buffer, req.hdrlen, req.len);
					var tmp2 = decodeUTF8(tmp1);
					data = JSON.parse(tmp2);
				}

				if (this.connected)
					this.ondatamessage(data, req);
				else
					this.onauthmessage(data, req);
			}

			/*
			 * Try to handle getting no reply back from the server gracefully.
			 */
			this.checkRequests = function () {
				for (var r in this.requests) {
					/* throw away requests left from a previous connection */
					if (this.requests[r].generation != this.generation) {
						delete this.requests[r];
						continue;
					}
					var req = this.requests[r];
					if (tm() - req.time > this.TIMEOUT) {
						try {
							req.onTimeout();
						} catch (e) {
							console.error(e);
						} finally {
							delete this.requests[r];
						}
					}
				}
			}
			this._xid = setInterval(this.checkRequests.bind(this), 2000);

			if (self.onConnectionAdded)
				self.onConnectionAdded(this);
		}

		Connection.prototype.setKeepAlive = function (timeout) {

			var to = parseInt(timeout);
			if (isNaN(to))
				throw (new Exception('invalid keep alive:' + timeout));

			this.TIMEOUT = to;
		}

		Connection.prototype.delete = function () {

			if (this.connected)
				throw (new PhidgetError(ErrorCode.BUSY, 'close connection before deleting'));

			if (self.onConnectionRemoved)
				self.onConnectionRemoved(this);

			delete Connections[this.id];
		}

		Connection.prototype.getChannel = function (chid) {

			if (this.Channels[chid] === undefined)
				throw (new PhidgetError(ErrorCode.UNEXPECTED, 'invalid channel id:' + chid));
			return (this.Channels[chid]);
		}

		Connection.prototype.getDevice = function (phid) {

			if (!this.Devices[phid])
				return (null);
			return (this.Devices[phid]);
		}

		Connection.prototype.close = function () {

			this.stayopen = false;
			this.closesocket();
		}

		Connection.prototype.closesocket = function () {

			if (this.connected === true)
				this.onDisconnect();
			this.connected = false;

			if (this.ws != undefined) {
				try {
					this.ws.close();
				} catch (ex) {}
			} else if (this.sock != undefined) {
				try {
					this.sock.destroy();
					this.sock.unref();
				} catch (ex) { }
			}

			this.ws = undefined;
			this.sock = undefined;
			this.generation++;
		}

		Connection.prototype.send = function (hdr, data) {

			var self = this;
			var err = false;
			return (new Promise(function (resolve, reject) {
				try {
					if (self.websocket) {
						if (!self.ws || self.ws.readyState != WebSocket.OPEN)
							reject(new PhidgetError(ErrorCode.UNEXPECTED, 'invalid websocket state'));
						self.ws.send(hdr);
						if (data.length > 0)
							self.ws.send(data);
					} else {
						if (!self.sock)
							reject(new PhidgetError(ErrorCode.UNEXPECTED, 'invalid socket'));
						var buffer = new Buffer(hdr.byteLength);
						for (var i = 0; i < hdr.length; i++)
							buffer[i] = hdr[i];
						self.sock.write(buffer);
						if (data.length > 0)
							self.sock.write(data);
					}
				} catch (ex) {
					err = true;
					reject(new PhidgetError(ErrorCode.UNEXPECTED, ex.message));
				} finally {
					if (!err)
						resolve();
				}
			}));
		}

		Connection.prototype.getNextRequestSequence = function () {

			if (this.reqseq >= 65535)
				this.reqseq = 10;

			this.reqseq++;
			return (this.reqseq);
		}

		Connection.prototype.sendRequest = function (flags, reqseq, repseq, type, stype, data) {

			var self = this;

			if (reqseq === 0) {

				reqseq = this.getNextRequestSequence();
			}

			return (new Promise(function (resolve, reject) {
				self.requests[reqseq] = {
					generation: self.generation,
					time: tm(),
					onReply: function (res) {
						if (res.E !== undefined) {
							if (res.E !== 0) {
								if (res.R !== undefined)
									reject(new PhidgetError(res.E, res.R));
								reject(new PhidgetError(res.E));
							} else {
								resolve(res.R);
							}
						} else {
							resolve(res);
						}
					},
					onTimeout: function () {
						reject(new PhidgetError(ErrorCode.TIMEOUT));
					},
					onError: function(code, msg) {
						reject(new PhidgetError(code, msg));
					}
				};

				if (self.websocket) {
					var dataArr = encodeUTF8(data);
					var req = new Request(dataArr.length, flags, reqseq, repseq, type, stype);
					self.send(req.buffer, dataArr).catch(function (err) {
						reject(err);
					});
				} else {
					var req = new Request(data.length, flags, reqseq, repseq, type, stype);
					self.send(req.buffer, data).catch(function (err) {
						reject(err);
					});
				}
			}));
		}

		Connection.prototype.sendReply = function(repseq, type, stype, data) {

			var NRF_REPLY = 0x0002;

			var reqseq = this.getNextRequestSequence();

			if (this.websocket) {
				var dataArr = encodeUTF8(data);
				var req = new Request(dataArr.length, NRF_REPLY, reqseq, repseq, type, stype);
				return (this.send(req.buffer, dataArr));
			} else {
				var req = new Request(data.length, NRF_REPLY, reqseq, repseq, type, stype);
				return (this.send(req.buffer, data));
			}
		}

		Connection.prototype.maintainConnection = function () {

			this.connected = true;
			this.stayopen = true;

			if (this.connectionMaintainer !== undefined)
				return;

			this.connectionMaintainer = setInterval(function () {
				var self = this;

				if (this.connected === true || this.stayopen !== true)
					return;

				this.connect().catch(function (err) {
					self.onError(err.errorCode, err.message);
				});
			}.bind(this), 4000);
		}

		Connection.prototype.connect = function() {

			if (this.connected === true)
				return (Promise.resolve(this));

			var self = this;

			return (new Promise(function (resolve, reject) {

				var hasConnected = false;
				function whenconnected() {
					hasConnected = true;
					self.handshake().then(function () {
						self.maintainConnection();
						resolve();
					}).catch(function (err) {
						reject(err);
					});
				}

				try {
					if (isNode) {
						if (self.sock) {
							try {
								self.sock.close();
							} catch (e) { }
							delete self.sock;
						}

						self.sock = new net.Socket();
						self.sock.on('data', Connection_sock_onmessage.bind(self));
						self.sock.on('close', self.doclose.bind(self));
						self.sock.on('error', function (err) {
							var perr;
							switch (err.code) {
								case 'ECONNRESET':
									perr = new PhidgetError(ErrorCode.CONNECTION_RESET, err.message);
									break;
								case 'ECONNREFUSED':
									perr = new PhidgetError(ErrorCode.CONNECTION_REFUSED, err.message);
									break;
								default:
									perr = new PhidgetError(ErrorCode.UNEXPECTED, err.message);
									break;
							}
							this.doclose();

							if (hasConnected)
								this.onError(perr.errorCode, perr.message);
							else
								reject(perr);
						}.bind(self));
						self.sock.on('connect', whenconnected.bind(self));

						self.sock.connect({ host: self.hostname, port: self.port });
					} else {
						if (self.ws) {
							try {
								self.ws.close();
							} catch (e) { }
							delete self.ws;
						}
						self.websocket = true;
						self.ws = new WebSocket(self.uri);
						self.ws.onopen = whenconnected.bind(self);
						self.ws.onclose = self.doclose.bind(self);
						self.ws.onmessage = Connection_ws_onmessage.bind(self);
						self.ws.onerror = function (data) {
							this.onError(ErrorCode.CONNECTION_REFUSED, "websocket error - check that server is available");
							self.doclose();
						}.bind(self);
						self.ws.binaryType = 'arraybuffer';
					}
				} catch (e) {
					reject(new PhidgetError(ErrorCode.UNEXPECTED, e.message));
				}

			}));
		}

		Connection.prototype.doclose = function() {

			while (this.DeviceList.length > 0)
				this.deviceDetach(this.DeviceList[this.DeviceList.length -1]);

			this.closesocket();
		}

		Connection.prototype.onauthmessage = function(data, req) {

			if (this.authdata === undefined)
				console.error('packet recieved while not connected and authdata is not defined');
			else
				this.authdata(data);
		}

		Connection.prototype.ondatamessage = function(data, req) {

			var request = this.requests[req.repseq];
			if (request) {
				delete this.requests[req.repseq];
				request.onReply(data);
			}

			/*
			 * Replies do not require additional processing, but there must have been a request
			 * object registered.
			 */
			if (req.flags & NR.Reply) {
				if (request === undefined)
					this.onError(ErrorCode.UNEXPECTED, 'No handler registered for reply: ' + req);
				return;
			}

			switch(req.type) {
			case P22MSG.Command:
				var p = this.handleCommand(req, data);
				break;
			case P22MSG.Device:
				var p = this.handleDevice(req, data);
				break;
			case P22MSG.Channel:
				var p = this.handleChannel(req, data);
				break;
			default:
				var p = jPhidget_reject(ErrorCode.INVALID, 'Unknown request type:' + req.type);
			}
			if (p) {
				var self = this;
				p.catch(function(err) {
					self.onError(err.errorCode, err.message);
				});
			}
		}

		Connection.prototype.handleCommand = function(req, data) {

			switch (req.stype) {
			case P22SMSG.KeepAlive:
				return (this.sendReply(req.reqseq, P22MSG.Command, P22SMSG.KeepAlive, []));
			default:
				return (jPhidget_reject(ErrorCode.UNEXPECTED,
				  'Unknown command subrequest:' + req.stype));
			}
		}

		Connection.prototype.handleDevice = function(req, data) {

			switch(req.stype) {
			case P22SMSG.Attach:
				return (this.handleDeviceAttach(req, data));
			case P22SMSG.Detach:
				return (this.handleDeviceDetach(req, data));
			case P22SMSG.BridgePkt:
				return (this.handleBridgePacket(req, data));
			case P22SMSG.Channel:
				return (this.handleChannel(req, data));
			default:
				return (jPhidget_reject(ErrorCode.UNEXPECTED,
				  'Unknown device subrequest:' + req.stype));
			}
		}

		Connection.prototype.handleDeviceAttach = function(req, data) {

			var dev = new Device(this, data);
			if (dev.phid in this.Devices)
				return (jPhidget_reject(ErrorCode.DUPLICATE, 'duplicate device:' + dev));

			this.Devices[dev.phid] = dev;
			this.DeviceList.push(dev);
			this.onattach(dev);

			return (Promise.resolve());
		}

		Connection.prototype.handleDeviceDetach = function(req, data) {
			var dev;

			dev = this.getDevice(data.phid);
			if (dev !== -1)
				this.deviceDetach(dev);

			return (Promise.resolve());
		}

		Connection.prototype.deviceDetach = function(dev) {

			if (!(dev.phid in this.Devices))
				return (jPhidget_reject(ErrorCode.NO_SUCH_ENTITY, 'no such device:' + dev));

			for (var ch in this.Channels) {
				if (this.Channels[ch].parent === dev) {
					this.onchanneldetach(this.Channels[ch]);
					delete this.Channels[ch];
				}
			}

			this.ondetach(dev);
			delete this.Devices[dev.phid];
			this.DeviceList.splice(this.DeviceList.indexOf(dev), 1);

			return (Promise.resolve());
		}

		Connection.prototype.handleChannel = function(req, data) {
			var dev;
			var ch;

			dev = this.getDevice(data.parent);
			if (dev === null)
				return (jPhidget_reject(ErrorCode.UNEXPECTED, 'missing channel parent'));

			ch = new Channel(this, dev, data);
			this.Channels[ch.chid] = ch;
			this.onchannelattach(ch);

			return (Promise.resolve());
		}

		Connection.prototype.handleBridgePacket = function(req, data) {

			var bp = new BridgePacket(this, req, data);
			return (bp.deliver());
		}

		Connection.prototype.handshake = function () {

			var self = this;

			return (new Promise(function (resolve, reject) {

				function startAuthentication() {
					var json = JSON.stringify({
						name: NET_NAME, type: NET_TYPE, pmajor: NET_MAJOR,
						pminor: NET_MINOR
					});
					var req = new Request(json.length, 0, 0, 0, P22MSG.Connect, P22SMSG.HandShakeC0);
					self.send(req.buffer, json).catch(function (err) {
						reject(err);
					});
				}

				function authenticate(data) {
					if (data.result !== 0) {
						reject(new PhidgetError(data.result, 'server rejected handshake'));
						return;
					}

					/* start authentication */
					this.nonceC = createSalt(16);

					var json = JSON.stringify({ ident: NET_IDENT, nonceC: this.nonceC });
					var req = new Request(json.length, 0, 0, 0, P22MSG.Connect, P22SMSG.AuthC0);
					this.send(req.buffer, json).catch(function(err) {
						reject(err);
					});

					this.authdata = function (data) {
						if (data.result !== 0) {
							reject(new PhidgetError(data.result, 'authentication failed'));
							return;
						}

						if (this.nonceC != data.nonceC) {
							reject(new PhidgetError(ErrorCode.UNEXPECTED, 'Authentication Failure: nonce do not match (' +
								this.nonceC + ') vs (' + data.nonceC + ')'));
							return;
						}

						var challenge = NET_IDENT + this.passwd + this.nonceC + data.nonceS + data.salt;
						var proof = this.hash(challenge);
						var json = JSON.stringify({ nonceC: this.nonceC, nonceS: data.nonceS, proof: proof });

						req = new Request(json.length, 0, 0, 0, P22MSG.Connect, P22SMSG.AuthC1);
						this.send(req.buffer, json).catch(function(err) {
							reject(err);
						});

						this.authdata = function (data) {
							if (data.E != 0) {

								if (this.onAuthenticationNeeded) {
									var pass = this.onAuthenticationNeeded();
									if (pass !== undefined && typeof pass === 'string') {
										this.passwd = pass;
										delete this.authdata;

										setTimeout(function () {
											var self = this;

											this.connect().then(function () {
												resolve();
											}).catch(function (err) {
												reject(err);
											});
										}.bind(this), 100);
										return;
									}
								}

								reject(new PhidgetError(data.E, 'authentication failed: server rejected proof'));
								return;
							}
							this.connected = true; // prevent packets from being missed
							delete this.authdata;

							this.onConnect();
							resolve();
						}
					};
				};

				self.authdata = authenticate;
				startAuthentication();
			}));
		}

		Connection.prototype.hash = function(challenge) {

			if (isNode) {
				var sha = crypto.createHash('sha256');
				sha.update(challenge);
				return (sha.digest('base64'));
			}

			var digest = Sha256.hash(challenge);

			var bin = '';
			for (var i = 0; i < digest.length; i += 2) {
				var b = parseInt(digest.substring(i, i + 2), 16);
				bin += String.fromCharCode(b);
			}

			return (window.btoa(bin));
		}

		self.Connection = Connection;

		var Accelerometer = function Accelerometer() {
			Phidget.apply(this, arguments);
			this.name = "Accelerometer";
			this.class = ChannelClass.ACCELEROMETER;

			this.onAccelerationChange = function (acceleration, timestamp) {};
			this.onError = function (code, desc) {};
		};
		Accelerometer.prototype = Object.create(Phidget.prototype);
		Accelerometer.prototype.constructor = Accelerometer;
		self.Accelerometer = Accelerometer;

		Accelerometer.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		Accelerometer.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		Accelerometer.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 2 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_ACCELERATIONCHANGE:
				this.handleAccelerationChangeEvent(bp);
				break;
			}
			return (true);
		};

		Accelerometer.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETCHANGETRIGGER:
				this.data.accelerationChangeTrigger =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('AccelerationChangeTrigger');
				return (true);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETSPATIALPRECISION:
				this.data.precision =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Precision');
				return (true);
			}
		}

		Accelerometer.prototype.getAcceleration = function() {

			this.checkOpen();

			return (this.data.acceleration);
		};

		Accelerometer.prototype.getMinAcceleration = function() {

			this.checkOpen();

			return (this.data.minAcceleration);
		};

		Accelerometer.prototype.getMaxAcceleration = function() {

			this.checkOpen();

			return (this.data.maxAcceleration);
		};

		Accelerometer.prototype.getAccelerationChangeTrigger = function() {

			this.checkOpen();

			return (this.data.accelerationChangeTrigger);
		};

		Accelerometer.prototype.setAccelerationChangeTrigger = function(accelerationChangeTrigger) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: accelerationChangeTrigger });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCHANGETRIGGER).then(function (res) {
				self.data.accelerationChangeTrigger = accelerationChangeTrigger;
			}));
		};

		Accelerometer.prototype.getMinAccelerationChangeTrigger = function() {

			this.checkOpen();

			return (this.data.minAccelerationChangeTrigger);
		};

		Accelerometer.prototype.getMaxAccelerationChangeTrigger = function() {

			this.checkOpen();

			return (this.data.maxAccelerationChangeTrigger);
		};

		Accelerometer.prototype.getAxisCount = function() {

			this.checkOpen();

			return (this.data.axisCount);
		};

		Accelerometer.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		Accelerometer.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		Accelerometer.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		Accelerometer.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		Accelerometer.prototype.getPrecision = function() {

			this.checkOpen();

			return (this.data.precision);
		};

		Accelerometer.prototype.setPrecision = function(precision) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: precision });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETSPATIALPRECISION).then(function (res) {
				self.data.precision = precision;
			}));
		};

		Accelerometer.prototype.getTimestamp = function() {

			this.checkOpen();

			return (this.data.timestamp);
		};

		Accelerometer.prototype.handleAccelerationChangeEvent = function (bp) {

			this.data.acceleration = bp.get("0");
			this.data.timestamp = bp.get("1");

			this.onAccelerationChange(this.data.acceleration, this.data.timestamp);
		};


		var BLDCMotor = function BLDCMotor() {
			Phidget.apply(this, arguments);
			this.name = "BLDCMotor";
			this.class = ChannelClass.BLDC_MOTOR;

			this.onBrakingStrengthChange = function (brakingStrength) {};
			this.onPositionChange = function (position) {};
			this.onVelocityUpdate = function (velocity) {};
			this.onError = function (code, desc) {};
		};
		BLDCMotor.prototype = Object.create(Phidget.prototype);
		BLDCMotor.prototype.constructor = BLDCMotor;
		self.BLDCMotor = BLDCMotor;

		BLDCMotor.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		BLDCMotor.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		BLDCMotor.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 0 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_BRAKINGSTRENGTHCHANGE:
				this.handleBrakingStrengthChangeEvent(bp);
				break;
			case BridgePackets.BP_POSITIONCHANGE:
				this.handlePositionChangeEvent(bp);
				break;
			case BridgePackets.BP_DUTYCYCLECHANGE:
				this.handleVelocityUpdateEvent(bp);
				break;
			}
			return (true);
		};

		BLDCMotor.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETACCELERATION:
				this.data.acceleration =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Acceleration');
				return (true);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETSTALLVELOCITY:
				this.data.stallVelocity =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('StallVelocity');
				return (true);
			case BridgePackets.BP_SETBRAKINGDUTYCYCLE:
				this.data.targetBrakingStrength =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('TargetBrakingStrength');
				return (true);
			case BridgePackets.BP_SETDUTYCYCLE:
				this.data.targetVelocity =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('TargetVelocity');
				return (true);
			}
		}

		BLDCMotor.prototype.getAcceleration = function() {

			this.checkOpen();

			return (this.data.acceleration);
		};

		BLDCMotor.prototype.setAcceleration = function(acceleration) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: acceleration });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETACCELERATION).then(function (res) {
				self.data.acceleration = acceleration;
			}));
		};

		BLDCMotor.prototype.getMinAcceleration = function() {

			this.checkOpen();

			return (this.data.minAcceleration);
		};

		BLDCMotor.prototype.getMaxAcceleration = function() {

			this.checkOpen();

			return (this.data.maxAcceleration);
		};

		BLDCMotor.prototype.getBrakingStrength = function() {

			this.checkOpen();

			return (this.data.brakingStrength);
		};

		BLDCMotor.prototype.getMinBrakingStrength = function() {

			this.checkOpen();

			return (this.data.minBrakingStrength);
		};

		BLDCMotor.prototype.getMaxBrakingStrength = function() {

			this.checkOpen();

			return (this.data.maxBrakingStrength);
		};

		BLDCMotor.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		BLDCMotor.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		BLDCMotor.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		BLDCMotor.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		BLDCMotor.prototype.getPosition = function() {

			this.checkOpen();

			return (this.data.position);
		};

		BLDCMotor.prototype.getMinPosition = function() {

			this.checkOpen();

			return (this.data.minPosition);
		};

		BLDCMotor.prototype.getMaxPosition = function() {

			this.checkOpen();

			return (this.data.maxPosition);
		};

		BLDCMotor.prototype.getRescaleFactor = function() {

			this.checkOpen();

			return (this.data.rescaleFactor);
		};

		BLDCMotor.prototype.getStallVelocity = function() {

			this.checkOpen();

			return (this.data.stallVelocity);
		};

		BLDCMotor.prototype.setStallVelocity = function(stallVelocity) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: stallVelocity });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETSTALLVELOCITY).then(function (res) {
				self.data.stallVelocity = stallVelocity;
			}));
		};

		BLDCMotor.prototype.getMinStallVelocity = function() {

			this.checkOpen();

			return (this.data.minStallVelocity);
		};

		BLDCMotor.prototype.getMaxStallVelocity = function() {

			this.checkOpen();

			return (this.data.maxStallVelocity);
		};

		BLDCMotor.prototype.getTargetBrakingStrength = function() {

			this.checkOpen();

			return (this.data.targetBrakingStrength);
		};

		BLDCMotor.prototype.setTargetBrakingStrength = function(targetBrakingStrength) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: targetBrakingStrength });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETBRAKINGDUTYCYCLE).then(function (res) {
				self.data.targetBrakingStrength = targetBrakingStrength;
			}));
		};

		BLDCMotor.prototype.getTargetVelocity = function() {

			this.checkOpen();

			return (this.data.targetVelocity);
		};

		BLDCMotor.prototype.setTargetVelocity = function(targetVelocity) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: targetVelocity });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDUTYCYCLE).then(function (res) {
				self.data.targetVelocity = targetVelocity;
			}));
		};

		BLDCMotor.prototype.getVelocity = function() {

			this.checkOpen();

			return (this.data.velocity);
		};

		BLDCMotor.prototype.getMinVelocity = function() {

			this.checkOpen();

			return (this.data.minVelocity);
		};

		BLDCMotor.prototype.getMaxVelocity = function() {

			this.checkOpen();

			return (this.data.maxVelocity);
		};

		BLDCMotor.prototype.handleBrakingStrengthChangeEvent = function (bp) {

			this.data.brakingStrength = bp.get("0");

			this.onBrakingStrengthChange(this.data.brakingStrength);
		};

		BLDCMotor.prototype.handlePositionChangeEvent = function (bp) {

			this.data.position = bp.get("0");

			this.onPositionChange(this.data.position);
		};

		BLDCMotor.prototype.handleVelocityUpdateEvent = function (bp) {

			this.data.velocity = bp.get("0");

			this.onVelocityUpdate(this.data.velocity);
		};


		BLDCMotor.prototype.getPosition = function() {

			return (this.data.position * this.data.rescaleFactor);
		};

		BLDCMotor.prototype.getMinPosition = function() {

			return ((this.data.minPosition + this.data.positionOffset) * this.data.rescaleFactor);
		};

		BLDCMotor.prototype.getMaxPosition = function() {

			return ((this.data.maxPosition + this.data.positionOffset) * this.data.rescaleFactor);
		};

		BLDCMotor.prototype.addPositionOffset = function(positionOffset) {

			this.data.positionOffset += (positionOffset / this.data.rescaleFactor)
		};

		BLDCMotor.prototype.setRescaleFactor = function(rescaleFactor) {

			this.data.rescaleFactor = rescaleFactor;
		};

		BLDCMotor.prototype.getStallVelocity = function() {

			return (this.data.stallVelocity * this.data.rescaleFactor);
		};

		BLDCMotor.prototype.setStallVelocity = function(stallVelocity) {

			var calcVelocity = stallVelocity / this.data.rescaleFactor;

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "stallVelocity", type: "g", value: calcVelocity });
			bp.send(this.channel, BridgePackets.BP_SETSTALLVELOCITY, function () {
				this.data.stallVelocity = calcVelocity;
				if (typeof this.setStallVelocitySuccess === "function")
					this.setStallVelocitySuccess(calcVelocity);
			}.bind(this));
		};

		BLDCMotor.prototype.getMinStallVelocity = function() {

			return (this.data.minStallVelocity * this.data.rescaleFactor);
		};

		BLDCMotor.prototype.getMaxStallVelocity = function() {

			return (this.data.maxStallVelocity * this.data.rescaleFactor);
		};

		BLDCMotor.prototype.getAcceleration = function() {

			return (this.data.acceleration * this.data.rescaleFactor);
		};

		BLDCMotor.prototype.setAcceleration = function(acceleration) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var calcAccel = acceleration / this.data.rescaleFactor;
			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: calcAccel });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETACCELERATION).then(function (res) {
				self.data.acceleration = calcAccel;
			}));
		};

		BLDCMotor.prototype.getMinAcceleration = function() {

			return (this.data.minAcceleration * this.data.rescaleFactor);
		};

		BLDCMotor.prototype.getMaxAcceleration = function() {

			return (this.data.maxAcceleration * this.data.rescaleFactor);
		};

		BLDCMotor.prototype.getTargetVelocity = function() {

			return (this.data.targetVelocity * this.data.rescaleFactor);
		};

		BLDCMotor.prototype.setTargetVelocity = function(targetVelocity) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var calcVelocity = targetVelocity / this.data.rescaleFactor;
			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: calcVelocity });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDUTYCYCLE).then(function (res) {
				self.data.targetVelocity = calcVelocity;
			}));
		};

		BLDCMotor.prototype.getVelocity = function() {

			return (this.data.velocity * this.data.rescaleFactor);
		};

		BLDCMotor.prototype.getMinVelocity = function() {

			return (this.data.minVelocity * this.data.rescaleFactor);
		};

		BLDCMotor.prototype.getMaxVelocity = function() {

			return (this.data.maxVelocity * this.data.rescaleFactor);
		};

		BLDCMotor.prototype.handlePositionChangeEvent = function (bp) {

			this.data.position = bp.get("0");

			this.onPositionChange((this.data.position + this.data.positionOffset ) * this.data.rescaleFactor);
		};

		BLDCMotor.prototype.handleVelocityUpdateEvent = function (bp) {

			this.data.velocity = bp.get("0");

			this.onVelocityUpdate(this.data.velocity * this.data.rescaleFactor);
		};

		var CapacitiveTouch = function CapacitiveTouch() {
			Phidget.apply(this, arguments);
			this.name = "CapacitiveTouch";
			this.class = ChannelClass.CAPACITIVE_TOUCH;

			this.onTouch = function (touchValue) {};
			this.onTouchEnd = function () {};
			this.onError = function (code, desc) {};
		};
		CapacitiveTouch.prototype = Object.create(Phidget.prototype);
		CapacitiveTouch.prototype.constructor = CapacitiveTouch;
		self.CapacitiveTouch = CapacitiveTouch;

		CapacitiveTouch.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		CapacitiveTouch.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		CapacitiveTouch.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 2 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_TOUCHINPUTVALUECHANGE:
				this.handleTouchEvent(bp);
				break;
			case BridgePackets.BP_TOUCHINPUTEND:
				this.handleTouchEndEvent(bp);
				break;
			}
			return (true);
		};

		CapacitiveTouch.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETSENSITIVITY:
				this.data.sensitivity =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Sensitivity');
				return (true);
			case BridgePackets.BP_SETCHANGETRIGGER:
				this.data.touchValueChangeTrigger =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('TouchValueChangeTrigger');
				return (true);
			}
		}

		CapacitiveTouch.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		CapacitiveTouch.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		CapacitiveTouch.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		CapacitiveTouch.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		CapacitiveTouch.prototype.getIsTouched = function() {

			this.checkOpen();

			return (!!this.data.isTouched);
		};

		CapacitiveTouch.prototype.getSensitivity = function() {

			this.checkOpen();

			return (this.data.sensitivity);
		};

		CapacitiveTouch.prototype.setSensitivity = function(sensitivity) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: sensitivity });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETSENSITIVITY).then(function (res) {
				self.data.sensitivity = sensitivity;
			}));
		};

		CapacitiveTouch.prototype.getMinSensitivity = function() {

			this.checkOpen();

			return (this.data.minSensitivity);
		};

		CapacitiveTouch.prototype.getMaxSensitivity = function() {

			this.checkOpen();

			return (this.data.maxSensitivity);
		};

		CapacitiveTouch.prototype.getTouchValue = function() {

			this.checkOpen();

			return (this.data.touchValue);
		};

		CapacitiveTouch.prototype.getMinTouchValue = function() {

			this.checkOpen();

			return (this.data.minTouchValue);
		};

		CapacitiveTouch.prototype.getMaxTouchValue = function() {

			this.checkOpen();

			return (this.data.maxTouchValue);
		};

		CapacitiveTouch.prototype.getTouchValueChangeTrigger = function() {

			this.checkOpen();

			return (this.data.touchValueChangeTrigger);
		};

		CapacitiveTouch.prototype.setTouchValueChangeTrigger = function(touchValueChangeTrigger) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: touchValueChangeTrigger });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCHANGETRIGGER).then(function (res) {
				self.data.touchValueChangeTrigger = touchValueChangeTrigger;
			}));
		};

		CapacitiveTouch.prototype.getMinTouchValueChangeTrigger = function() {

			this.checkOpen();

			return (this.data.minTouchValueChangeTrigger);
		};

		CapacitiveTouch.prototype.getMaxTouchValueChangeTrigger = function() {

			this.checkOpen();

			return (this.data.maxTouchValueChangeTrigger);
		};

		CapacitiveTouch.prototype.handleTouchEvent = function (bp) {

			this.data.touchValue = bp.get("0");

			this.onTouch(this.data.touchValue);
		};

		CapacitiveTouch.prototype.handleTouchEndEvent = function (bp) {


			this.onTouchEnd();
		};


		var CurrentInput = function CurrentInput() {
			Phidget.apply(this, arguments);
			this.name = "CurrentInput";
			this.class = ChannelClass.CURRENT_INPUT;

			this.onCurrentChange = function (current) {};
			this.onError = function (code, desc) {};
		};
		CurrentInput.prototype = Object.create(Phidget.prototype);
		CurrentInput.prototype.constructor = CurrentInput;
		self.CurrentInput = CurrentInput;

		CurrentInput.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		CurrentInput.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		CurrentInput.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 0 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_CURRENTCHANGE:
				this.handleCurrentChangeEvent(bp);
				break;
			}
			return (true);
		};

		CurrentInput.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETCHANGETRIGGER:
				this.data.currentChangeTrigger =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('CurrentChangeTrigger');
				return (true);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETPOWERSUPPLY:
				this.data.powerSupply =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('PowerSupply');
				return (true);
			}
		}

		CurrentInput.prototype.getCurrent = function() {

			this.checkOpen();

			return (this.data.current);
		};

		CurrentInput.prototype.getMinCurrent = function() {

			this.checkOpen();

			return (this.data.minCurrent);
		};

		CurrentInput.prototype.getMaxCurrent = function() {

			this.checkOpen();

			return (this.data.maxCurrent);
		};

		CurrentInput.prototype.getCurrentChangeTrigger = function() {

			this.checkOpen();

			return (this.data.currentChangeTrigger);
		};

		CurrentInput.prototype.setCurrentChangeTrigger = function(currentChangeTrigger) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: currentChangeTrigger });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCHANGETRIGGER).then(function (res) {
				self.data.currentChangeTrigger = currentChangeTrigger;
			}));
		};

		CurrentInput.prototype.getMinCurrentChangeTrigger = function() {

			this.checkOpen();

			return (this.data.minCurrentChangeTrigger);
		};

		CurrentInput.prototype.getMaxCurrentChangeTrigger = function() {

			this.checkOpen();

			return (this.data.maxCurrentChangeTrigger);
		};

		CurrentInput.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		CurrentInput.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		CurrentInput.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		CurrentInput.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		CurrentInput.prototype.getPowerSupply = function() {

			this.checkOpen();

			return (this.data.powerSupply);
		};

		CurrentInput.prototype.setPowerSupply = function(powerSupply) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: powerSupply });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETPOWERSUPPLY).then(function (res) {
				self.data.powerSupply = powerSupply;
			}));
		};

		CurrentInput.prototype.handleCurrentChangeEvent = function (bp) {

			this.data.current = bp.get("0");

			this.onCurrentChange(this.data.current);
		};


		var DCMotor = function DCMotor() {
			Phidget.apply(this, arguments);
			this.name = "DCMotor";
			this.class = ChannelClass.DC_MOTOR;

			this.onBrakingStrengthChange = function (brakingStrength) {};
			this.onVelocityUpdate = function (velocity) {};
			this.onBackEMFChange = function (backEMF) {};
			this.onError = function (code, desc) {};
		};
		DCMotor.prototype = Object.create(Phidget.prototype);
		DCMotor.prototype.constructor = DCMotor;
		self.DCMotor = DCMotor;

		DCMotor.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		DCMotor.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		DCMotor.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 0 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_BACKEMFCHANGE:
				this.handleBackEMFChangeEvent(bp);
				break;
			case BridgePackets.BP_BRAKINGSTRENGTHCHANGE:
				this.handleBrakingStrengthChangeEvent(bp);
				break;
			case BridgePackets.BP_DUTYCYCLECHANGE:
				this.handleVelocityUpdateEvent(bp);
				break;
			}
			return (true);
		};

		DCMotor.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETACCELERATION:
				this.data.acceleration =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Acceleration');
				return (true);
			case BridgePackets.BP_SETBACKEMFSENSINGSTATE:
				this.data.backEMFSensingState =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('BackEMFSensingState');
				return (true);
			case BridgePackets.BP_SETCURRENTLIMIT:
				this.data.currentLimit =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('CurrentLimit');
				return (true);
			case BridgePackets.BP_SETCURRENTREGULATORGAIN:
				this.data.currentRegulatorGain =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('CurrentRegulatorGain');
				return (true);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETFANMODE:
				this.data.fanMode =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('FanMode');
				return (true);
			case BridgePackets.BP_SETBRAKINGDUTYCYCLE:
				this.data.targetBrakingStrength =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('TargetBrakingStrength');
				return (true);
			case BridgePackets.BP_SETDUTYCYCLE:
				this.data.targetVelocity =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('TargetVelocity');
				return (true);
			}
		}

		DCMotor.prototype.getAcceleration = function() {

			this.checkOpen();

			return (this.data.acceleration);
		};

		DCMotor.prototype.setAcceleration = function(acceleration) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: acceleration });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETACCELERATION).then(function (res) {
				self.data.acceleration = acceleration;
			}));
		};

		DCMotor.prototype.getMinAcceleration = function() {

			this.checkOpen();

			return (this.data.minAcceleration);
		};

		DCMotor.prototype.getMaxAcceleration = function() {

			this.checkOpen();

			return (this.data.maxAcceleration);
		};

		DCMotor.prototype.getBackEMF = function() {

			this.checkOpen();

			return (this.data.backEMF);
		};

		DCMotor.prototype.getBackEMFSensingState = function() {

			this.checkOpen();

			return (!!this.data.backEMFSensingState);
		};

		DCMotor.prototype.setBackEMFSensingState = function(backEMFSensingState) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: backEMFSensingState });
			var self = this;
			return (bp.send(this.channel,
			  BridgePackets.BP_SETBACKEMFSENSINGSTATE).then(function (res) {
				self.data.backEMFSensingState = backEMFSensingState;
			}));
		};

		DCMotor.prototype.getBrakingStrength = function() {

			this.checkOpen();

			return (this.data.brakingStrength);
		};

		DCMotor.prototype.getMinBrakingStrength = function() {

			this.checkOpen();

			return (this.data.minBrakingStrength);
		};

		DCMotor.prototype.getMaxBrakingStrength = function() {

			this.checkOpen();

			return (this.data.maxBrakingStrength);
		};

		DCMotor.prototype.getCurrentLimit = function() {

			this.checkOpen();

			return (this.data.currentLimit);
		};

		DCMotor.prototype.setCurrentLimit = function(currentLimit) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: currentLimit });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCURRENTLIMIT).then(function (res) {
				self.data.currentLimit = currentLimit;
			}));
		};

		DCMotor.prototype.getMinCurrentLimit = function() {

			this.checkOpen();

			return (this.data.minCurrentLimit);
		};

		DCMotor.prototype.getMaxCurrentLimit = function() {

			this.checkOpen();

			return (this.data.maxCurrentLimit);
		};

		DCMotor.prototype.getCurrentRegulatorGain = function() {

			this.checkOpen();

			return (this.data.currentRegulatorGain);
		};

		DCMotor.prototype.setCurrentRegulatorGain = function(currentRegulatorGain) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: currentRegulatorGain });
			var self = this;
			return (bp.send(this.channel,
			  BridgePackets.BP_SETCURRENTREGULATORGAIN).then(function (res) {
				self.data.currentRegulatorGain = currentRegulatorGain;
			}));
		};

		DCMotor.prototype.getMinCurrentRegulatorGain = function() {

			this.checkOpen();

			return (this.data.minCurrentRegulatorGain);
		};

		DCMotor.prototype.getMaxCurrentRegulatorGain = function() {

			this.checkOpen();

			return (this.data.maxCurrentRegulatorGain);
		};

		DCMotor.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		DCMotor.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		DCMotor.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		DCMotor.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		DCMotor.prototype.getFanMode = function() {

			this.checkOpen();

			return (this.data.fanMode);
		};

		DCMotor.prototype.setFanMode = function(fanMode) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: fanMode });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETFANMODE).then(function (res) {
				self.data.fanMode = fanMode;
			}));
		};

		DCMotor.prototype.getTargetBrakingStrength = function() {

			this.checkOpen();

			return (this.data.targetBrakingStrength);
		};

		DCMotor.prototype.setTargetBrakingStrength = function(targetBrakingStrength) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: targetBrakingStrength });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETBRAKINGDUTYCYCLE).then(function (res) {
				self.data.targetBrakingStrength = targetBrakingStrength;
			}));
		};

		DCMotor.prototype.getTargetVelocity = function() {

			this.checkOpen();

			return (this.data.targetVelocity);
		};

		DCMotor.prototype.setTargetVelocity = function(targetVelocity) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: targetVelocity });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDUTYCYCLE).then(function (res) {
				self.data.targetVelocity = targetVelocity;
			}));
		};

		DCMotor.prototype.getVelocity = function() {

			this.checkOpen();

			return (this.data.velocity);
		};

		DCMotor.prototype.getMinVelocity = function() {

			this.checkOpen();

			return (this.data.minVelocity);
		};

		DCMotor.prototype.getMaxVelocity = function() {

			this.checkOpen();

			return (this.data.maxVelocity);
		};

		DCMotor.prototype.handleBackEMFChangeEvent = function (bp) {

			this.data.backEMF = bp.get("0");

			this.onBackEMFChange(this.data.backEMF);
		};

		DCMotor.prototype.handleBrakingStrengthChangeEvent = function (bp) {

			this.data.brakingStrength = bp.get("0");

			this.onBrakingStrengthChange(this.data.brakingStrength);
		};

		DCMotor.prototype.handleVelocityUpdateEvent = function (bp) {

			this.data.velocity = bp.get("0");

			this.onVelocityUpdate(this.data.velocity);
		};


		var Dictionary = function Dictionary() {
			Phidget.apply(this, arguments);
			this.name = "Dictionary";
			this.class = ChannelClass.DICTIONARY;

			this.onAdd = function (key, value) {};
			this.onUpdate = function (key, value) {};
			this.onRemove = function (key) {};
			this.onError = function (code, desc) {};
		};
		Dictionary.prototype = Object.create(Phidget.prototype);
		Dictionary.prototype.constructor = Dictionary;
		self.Dictionary = Dictionary;

		Dictionary.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		Dictionary.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		Dictionary.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 0 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_DICTIONARYADDED:
				this.handleAddEvent(bp);
				break;
			case BridgePackets.BP_DICTIONARYREMOVED:
				this.handleRemoveEvent(bp);
				break;
			case BridgePackets.BP_DICTIONARYUPDATED:
				this.handleUpdateEvent(bp);
				break;
			}
			return (true);
		};

		Dictionary.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			}
		}

		Dictionary.prototype.add = function(key, value) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "s", value: key });
			bp.set({ name: "1", type: "s", value: value });
			return (bp.send(this.channel, BridgePackets.BP_DICTIONARYADD));
		};

		Dictionary.prototype.removeAll = function() {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			return (bp.send(this.channel, BridgePackets.BP_DICTIONARYREMOVEALL));
		};

		Dictionary.prototype.get = function(key) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "s", value: key });
			bp.set({ name: "1", type: "s", value: value });
			bp.set({ name: "2", type: "d", value: valueLen });
			return (bp.send(this.channel, BridgePackets.BP_DICTIONARYGET));
		};

		Dictionary.prototype.remove = function(key) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "s", value: key });
			return (bp.send(this.channel, BridgePackets.BP_DICTIONARYREMOVE));
		};

		Dictionary.prototype.scan = function(start) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "s", value: start });
			bp.set({ name: "1", type: "s", value: keyList });
			bp.set({ name: "2", type: "d", value: keyListLen });
			return (bp.send(this.channel, BridgePackets.BP_DICTIONARYSCAN));
		};

		Dictionary.prototype.set = function(key, value) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "s", value: key });
			bp.set({ name: "1", type: "s", value: value });
			return (bp.send(this.channel, BridgePackets.BP_DICTIONARYSET));
		};

		Dictionary.prototype.update = function(key, value) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "s", value: key });
			bp.set({ name: "1", type: "s", value: value });
			return (bp.send(this.channel, BridgePackets.BP_DICTIONARYUPDATE));
		};

		Dictionary.prototype.handleAddEvent = function (bp) {

			var key = bp.get("0");
			var value = bp.get("1");

			this.onAdd(key, value);
		};

		Dictionary.prototype.handleRemoveEvent = function (bp) {

			var key = bp.get("0");

			this.onRemove(key);
		};

		Dictionary.prototype.handleUpdateEvent = function (bp) {

			var key = bp.get("0");
			var value = bp.get("1");

			this.onUpdate(key, value);
		};

		Dictionary.prototype.get = function (key, def /* optional */) {

			var self = this;

			return (new Promise(function (resolve, reject) {
				var bp = new BridgePacket(self.channel.conn);
				bp.set({ name: "key", type: "s", value: key });
				bp.send(self.channel, BridgePackets.BP_DICTIONARYGET).then(function (val) {
					resolve(val);
				}).catch(function (err) {
					if (def !== undefined)
						resolve(def, key);
					else
						reject(err);
				});
			}));
		};

		Dictionary.prototype.scan = function (key) {

			var self = this;

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "startKey", type: "s", value: key });
			return (bp.send(self.channel, BridgePackets.BP_DICTIONARYSCAN).then(function (list) {
				if (list.length == 0)
					return ([]);
				return (list.trim().split('\n'));
			}));
		};

		var DigitalInput = function DigitalInput() {
			Phidget.apply(this, arguments);
			this.name = "DigitalInput";
			this.class = ChannelClass.DIGITAL_INPUT;

			this.onStateChange = function (state) {};
			this.onError = function (code, desc) {};
		};
		DigitalInput.prototype = Object.create(Phidget.prototype);
		DigitalInput.prototype.constructor = DigitalInput;
		self.DigitalInput = DigitalInput;

		DigitalInput.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		DigitalInput.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		DigitalInput.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 0 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_STATECHANGE:
				this.handleStateChangeEvent(bp);
				break;
			}
			return (true);
		};

		DigitalInput.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETINPUTMODE:
				this.data.inputMode =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('InputMode');
				return (true);
			case BridgePackets.BP_SETPOWERSUPPLY:
				this.data.powerSupply =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('PowerSupply');
				return (true);
			}
		}

		DigitalInput.prototype.getInputMode = function() {

			this.checkOpen();

			return (this.data.inputMode);
		};

		DigitalInput.prototype.setInputMode = function(inputMode) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: inputMode });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETINPUTMODE).then(function (res) {
				self.data.inputMode = inputMode;
			}));
		};

		DigitalInput.prototype.getPowerSupply = function() {

			this.checkOpen();

			return (this.data.powerSupply);
		};

		DigitalInput.prototype.setPowerSupply = function(powerSupply) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: powerSupply });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETPOWERSUPPLY).then(function (res) {
				self.data.powerSupply = powerSupply;
			}));
		};

		DigitalInput.prototype.getState = function() {

			this.checkOpen();

			return (!!this.data.state);
		};

		DigitalInput.prototype.handleStateChangeEvent = function (bp) {

			this.data.state = !!bp.get("0");

			this.onStateChange(this.data.state);
		};


		var DigitalOutput = function DigitalOutput() {
			Phidget.apply(this, arguments);
			this.name = "DigitalOutput";
			this.class = ChannelClass.DIGITAL_OUTPUT;

			this.onError = function (code, desc) {};
		};
		DigitalOutput.prototype = Object.create(Phidget.prototype);
		DigitalOutput.prototype.constructor = DigitalOutput;
		self.DigitalOutput = DigitalOutput;

		DigitalOutput.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		DigitalOutput.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		DigitalOutput.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 1 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			}
			return (true);
		};

		DigitalOutput.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETDUTYCYCLE:
				this.data.dutyCycle =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DutyCycle');
				return (true);
			case BridgePackets.BP_SETLEDCURRENTLIMIT:
				this.data.LEDCurrentLimit =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('LEDCurrentLimit');
				return (true);
			case BridgePackets.BP_SETLEDFORWARDVOLTAGE:
				this.data.LEDForwardVoltage =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('LEDForwardVoltage');
				return (true);
			case BridgePackets.BP_SETSTATE:
				this.data.state =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('State');
				return (true);
			}
		}

		DigitalOutput.prototype.getDutyCycle = function() {

			this.checkOpen();

			return (this.data.dutyCycle);
		};

		DigitalOutput.prototype.setDutyCycle = function(dutyCycle) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: dutyCycle });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDUTYCYCLE).then(function (res) {
				self.data.dutyCycle = dutyCycle;
			}));
		};

		DigitalOutput.prototype.getMinDutyCycle = function() {

			this.checkOpen();

			return (this.data.minDutyCycle);
		};

		DigitalOutput.prototype.getMaxDutyCycle = function() {

			this.checkOpen();

			return (this.data.maxDutyCycle);
		};

		DigitalOutput.prototype.enableFailsafe = function(failsafeTime) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: failsafeTime });
			return (bp.send(this.channel, BridgePackets.BP_SETFAILSAFETIME));
		};

		DigitalOutput.prototype.getMinFailsafeTime = function() {

			this.checkOpen();

			return (this.data.minFailsafeTime);
		};

		DigitalOutput.prototype.getMaxFailsafeTime = function() {

			this.checkOpen();

			return (this.data.maxFailsafeTime);
		};

		DigitalOutput.prototype.getLEDCurrentLimit = function() {

			this.checkOpen();

			return (this.data.LEDCurrentLimit);
		};

		DigitalOutput.prototype.setLEDCurrentLimit = function(LEDCurrentLimit) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: LEDCurrentLimit });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETLEDCURRENTLIMIT).then(function (res) {
				self.data.LEDCurrentLimit = LEDCurrentLimit;
			}));
		};

		DigitalOutput.prototype.getMinLEDCurrentLimit = function() {

			this.checkOpen();

			return (this.data.minLEDCurrentLimit);
		};

		DigitalOutput.prototype.getMaxLEDCurrentLimit = function() {

			this.checkOpen();

			return (this.data.maxLEDCurrentLimit);
		};

		DigitalOutput.prototype.getLEDForwardVoltage = function() {

			this.checkOpen();

			return (this.data.LEDForwardVoltage);
		};

		DigitalOutput.prototype.setLEDForwardVoltage = function(LEDForwardVoltage) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: LEDForwardVoltage });
			var self = this;
			return (bp.send(this.channel,
			  BridgePackets.BP_SETLEDFORWARDVOLTAGE).then(function (res) {
				self.data.LEDForwardVoltage = LEDForwardVoltage;
			}));
		};

		DigitalOutput.prototype.resetFailsafe = function() {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			return (bp.send(this.channel, BridgePackets.BP_FAILSAFERESET));
		};

		DigitalOutput.prototype.getState = function() {

			this.checkOpen();

			return (!!this.data.state);
		};

		DigitalOutput.prototype.setState = function(state) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: state });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETSTATE).then(function (res) {
				self.data.state = state;
			}));
		};


		var DistanceSensor = function DistanceSensor() {
			Phidget.apply(this, arguments);
			this.name = "DistanceSensor";
			this.class = ChannelClass.DISTANCE_SENSOR;

			this.onDistanceChange = function (distance) {};
			this.onSonarReflectionsUpdate = function (distances, amplitudes, count) {};
			this.onError = function (code, desc) {};
		};
		DistanceSensor.prototype = Object.create(Phidget.prototype);
		DistanceSensor.prototype.constructor = DistanceSensor;
		self.DistanceSensor = DistanceSensor;

		DistanceSensor.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		DistanceSensor.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		DistanceSensor.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 1 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_DISTANCECHANGE:
				this.handleDistanceChangeEvent(bp);
				break;
			case BridgePackets.BP_SONARUPDATE:
				this.handleSonarReflectionsUpdateEvent(bp);
				break;
			}
			return (true);
		};

		DistanceSensor.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETCHANGETRIGGER:
				this.data.distanceChangeTrigger =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DistanceChangeTrigger');
				return (true);
			case BridgePackets.BP_SETSONARQUIETMODE:
				this.data.sonarQuietMode =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('SonarQuietMode');
				return (true);
			}
		}

		DistanceSensor.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		DistanceSensor.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		DistanceSensor.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		DistanceSensor.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		DistanceSensor.prototype.getDistance = function() {

			this.checkOpen();

			return (this.data.distance);
		};

		DistanceSensor.prototype.getMinDistance = function() {

			this.checkOpen();

			return (this.data.minDistance);
		};

		DistanceSensor.prototype.getMaxDistance = function() {

			this.checkOpen();

			return (this.data.maxDistance);
		};

		DistanceSensor.prototype.getDistanceChangeTrigger = function() {

			this.checkOpen();

			return (this.data.distanceChangeTrigger);
		};

		DistanceSensor.prototype.setDistanceChangeTrigger = function(distanceChangeTrigger) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: distanceChangeTrigger });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCHANGETRIGGER).then(function (res) {
				self.data.distanceChangeTrigger = distanceChangeTrigger;
			}));
		};

		DistanceSensor.prototype.getMinDistanceChangeTrigger = function() {

			this.checkOpen();

			return (this.data.minDistanceChangeTrigger);
		};

		DistanceSensor.prototype.getMaxDistanceChangeTrigger = function() {

			this.checkOpen();

			return (this.data.maxDistanceChangeTrigger);
		};

		DistanceSensor.prototype.getSonarQuietMode = function() {

			this.checkOpen();

			return (!!this.data.sonarQuietMode);
		};

		DistanceSensor.prototype.setSonarQuietMode = function(sonarQuietMode) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: sonarQuietMode });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETSONARQUIETMODE).then(function (res) {
				self.data.sonarQuietMode = sonarQuietMode;
			}));
		};

		DistanceSensor.prototype.handleDistanceChangeEvent = function (bp) {

			this.data.distance = bp.get("0");

			this.onDistanceChange(this.data.distance);
		};

		DistanceSensor.prototype.handleSonarReflectionsUpdateEvent = function (bp) {

			var distances = bp.get("0");
			var amplitudes = bp.get("1");
			var count = bp.get("2");

			this.onSonarReflectionsUpdate(distances, amplitudes, count);
		};


		DistanceSensor.prototype.getSonarReflections = function () {
			this.checkOpen();

			return ({
				distances: this.data.distances,
				amplitudes: this.data.amplitudes,
				count: this.data.count
			});
		};

		var Encoder = function Encoder() {
			Phidget.apply(this, arguments);
			this.name = "Encoder";
			this.class = ChannelClass.ENCODER;

			this.onPositionChange = function (positionChange, timeChange, indexTriggered) {};
			this.onError = function (code, desc) {};
		};
		Encoder.prototype = Object.create(Phidget.prototype);
		Encoder.prototype.constructor = Encoder;
		self.Encoder = Encoder;

		Encoder.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		Encoder.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		Encoder.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 1 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_POSITIONCHANGE:
				this.handlePositionChangeEvent(bp);
				break;
			}
			return (true);
		};

		Encoder.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETENABLED:
				this.data.enabled =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Enabled');
				return (true);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETIOMODE:
				this.data.IOMode =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('IOMode');
				return (true);
			case BridgePackets.BP_SETCHANGETRIGGER:
				this.data.positionChangeTrigger =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('PositionChangeTrigger');
				return (true);
			}
		}

		Encoder.prototype.setEnabled = function(enabled) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: enabled });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETENABLED).then(function (res) {
				self.data.enabled = enabled;
			}));
		};

		Encoder.prototype.getEnabled = function() {

			this.checkOpen();

			return (!!this.data.enabled);
		};

		Encoder.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		Encoder.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		Encoder.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		Encoder.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		Encoder.prototype.getIndexPosition = function() {

			this.checkOpen();

			return (this.data.indexPosition);
		};

		Encoder.prototype.getIOMode = function() {

			this.checkOpen();

			return (this.data.IOMode);
		};

		Encoder.prototype.setIOMode = function(IOMode) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: IOMode });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETIOMODE).then(function (res) {
				self.data.IOMode = IOMode;
			}));
		};

		Encoder.prototype.getPosition = function() {

			this.checkOpen();

			return (this.data.position);
		};

		Encoder.prototype.getPositionChangeTrigger = function() {

			this.checkOpen();

			return (this.data.positionChangeTrigger);
		};

		Encoder.prototype.setPositionChangeTrigger = function(positionChangeTrigger) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: positionChangeTrigger });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCHANGETRIGGER).then(function (res) {
				self.data.positionChangeTrigger = positionChangeTrigger;
			}));
		};

		Encoder.prototype.getMinPositionChangeTrigger = function() {

			this.checkOpen();

			return (this.data.minPositionChangeTrigger);
		};

		Encoder.prototype.getMaxPositionChangeTrigger = function() {

			this.checkOpen();

			return (this.data.maxPositionChangeTrigger);
		};

		Encoder.prototype.handlePositionChangeEvent = function (bp) {

			var positionChange = bp.get("0");
			var timeChange = bp.get("1");
			var indexTriggered = !!bp.get("2");

			this.onPositionChange(positionChange, timeChange, indexTriggered);
		};

		Encoder.prototype.handlePositionChangeEvent = function (bp) {

			var positionChange = bp.get("0");
			var timeChange = bp.get("1");
			var indexTriggered = bp.get("2");
			var indexPosition = 0;

			if (indexTriggered) {
				indexPosition = bp.get("3");
				this.data.indexPosition = this.data.position + indexPosition;
			}
			this.data.position += positionChange;
			this.onPositionChange(positionChange, timeChange, indexTriggered)
		}

		Encoder.prototype.setPosition = function (position) {

			if (this.data.indexPosition != 1e300)
				this.data.indexPosition += (position - this.data.position);
			this.data.position = position;
		}

		var FirmwareUpgrade = function FirmwareUpgrade() {
			Phidget.apply(this, arguments);
			this.name = "FirmwareUpgrade";
			this.class = ChannelClass.FIRMWARE_UPGRADE;

			this.onProgressChange = function (progress) {};
			this.onError = function (code, desc) {};
		};
		FirmwareUpgrade.prototype = Object.create(Phidget.prototype);
		FirmwareUpgrade.prototype.constructor = FirmwareUpgrade;
		self.FirmwareUpgrade = FirmwareUpgrade;

		FirmwareUpgrade.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		FirmwareUpgrade.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		FirmwareUpgrade.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 1 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_PROGRESSCHANGE:
				this.handleProgressChangeEvent(bp);
				break;
			}
			return (true);
		};

		FirmwareUpgrade.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			}
		}

		FirmwareUpgrade.prototype.getActualDeviceID = function() {

			this.checkOpen();

			return (this.data.actualDeviceID);
		};

		FirmwareUpgrade.prototype.getActualDeviceName = function() {

			this.checkOpen();

			return (this.data.actualDeviceName);
		};

		FirmwareUpgrade.prototype.getActualDeviceSKU = function() {

			this.checkOpen();

			return (this.data.actualDeviceSKU);
		};

		FirmwareUpgrade.prototype.getActualDeviceVersion = function() {

			this.checkOpen();

			return (this.data.actualDeviceVersion);
		};

		FirmwareUpgrade.prototype.getActualDeviceVINTID = function() {

			this.checkOpen();

			return (this.data.actualDeviceVINTID);
		};

		FirmwareUpgrade.prototype.getProgress = function() {

			this.checkOpen();

			return (this.data.progress);
		};

		FirmwareUpgrade.prototype.sendFirmware = function(data) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "c", value: data });
			bp.set({ name: "1", type: "d", value: dataLen });
			return (bp.send(this.channel, BridgePackets.BP_SENDFIRMWARE));
		};

		FirmwareUpgrade.prototype.handleProgressChangeEvent = function (bp) {

			this.data.progress = bp.get("0");

			this.onProgressChange(this.data.progress);
		};


		var FrequencyCounter = function FrequencyCounter() {
			Phidget.apply(this, arguments);
			this.name = "FrequencyCounter";
			this.class = ChannelClass.FREQUENCY_COUNTER;

			this.onFrequencyChange = function (frequency) {};
			this.onCountChange = function (counts, timeChange) {};
			this.onError = function (code, desc) {};
		};
		FrequencyCounter.prototype = Object.create(Phidget.prototype);
		FrequencyCounter.prototype.constructor = FrequencyCounter;
		self.FrequencyCounter = FrequencyCounter;

		FrequencyCounter.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		FrequencyCounter.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		FrequencyCounter.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 2 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_COUNTCHANGE:
				this.handleCountChangeEvent(bp);
				break;
			case BridgePackets.BP_FREQUENCYCHANGE:
				this.handleFrequencyChangeEvent(bp);
				break;
			}
			return (true);
		};

		FrequencyCounter.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETENABLED:
				this.data.enabled =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Enabled');
				return (true);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETFILTERTYPE:
				this.data.filterType =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('FilterType');
				return (true);
			case BridgePackets.BP_SETINPUTMODE:
				this.data.inputMode =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('InputMode');
				return (true);
			case BridgePackets.BP_SETPOWERSUPPLY:
				this.data.powerSupply =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('PowerSupply');
				return (true);
			}
		}

		FrequencyCounter.prototype.getCount = function() {

			this.checkOpen();

			return (this.data.count);
		};

		FrequencyCounter.prototype.getEnabled = function() {

			this.checkOpen();

			return (!!this.data.enabled);
		};

		FrequencyCounter.prototype.setEnabled = function(enabled) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: enabled });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETENABLED).then(function (res) {
				self.data.enabled = enabled;
			}));
		};

		FrequencyCounter.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		FrequencyCounter.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		FrequencyCounter.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		FrequencyCounter.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		FrequencyCounter.prototype.getFilterType = function() {

			this.checkOpen();

			return (this.data.filterType);
		};

		FrequencyCounter.prototype.setFilterType = function(filterType) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: filterType });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETFILTERTYPE).then(function (res) {
				self.data.filterType = filterType;
			}));
		};

		FrequencyCounter.prototype.getFrequency = function() {

			this.checkOpen();

			return (this.data.frequency);
		};

		FrequencyCounter.prototype.getMaxFrequency = function() {

			this.checkOpen();

			return (this.data.maxFrequency);
		};

		FrequencyCounter.prototype.getFrequencyCutoff = function() {

			this.checkOpen();

			return (this.data.frequencyCutoff);
		};

		FrequencyCounter.prototype.getMinFrequencyCutoff = function() {

			this.checkOpen();

			return (this.data.minFrequencyCutoff);
		};

		FrequencyCounter.prototype.getMaxFrequencyCutoff = function() {

			this.checkOpen();

			return (this.data.maxFrequencyCutoff);
		};

		FrequencyCounter.prototype.getInputMode = function() {

			this.checkOpen();

			return (this.data.inputMode);
		};

		FrequencyCounter.prototype.setInputMode = function(inputMode) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: inputMode });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETINPUTMODE).then(function (res) {
				self.data.inputMode = inputMode;
			}));
		};

		FrequencyCounter.prototype.getPowerSupply = function() {

			this.checkOpen();

			return (this.data.powerSupply);
		};

		FrequencyCounter.prototype.setPowerSupply = function(powerSupply) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: powerSupply });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETPOWERSUPPLY).then(function (res) {
				self.data.powerSupply = powerSupply;
			}));
		};

		FrequencyCounter.prototype.getTimeElapsed = function() {

			this.checkOpen();

			return (this.data.timeElapsed);
		};

		FrequencyCounter.prototype.handleCountChangeEvent = function (bp) {

			var counts = bp.get("0");
			var timeChange = bp.get("1");

			this.onCountChange(counts, timeChange);
		};

		FrequencyCounter.prototype.handleFrequencyChangeEvent = function (bp) {

			this.data.frequency = bp.get("0");

			this.onFrequencyChange(this.data.frequency);
		};

		FrequencyCounter.prototype.handleUnsupportedBridgePacket = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_FREQUENCYDATA:
				var ticks = bp.get("0");
				var counts = bp.get("1");
				var ticksAtLastCount = bp.get("2");
				var countTimeSpan;
				var cutoffTime;
				var precision;
				var d;

				this.data.timeElapsed += ticks;
				this.data.count += counts;

				if (counts == 0) {
					// do not accumulate if timed out
					if (!this.data.hasOwnProperty('totalTicksSinceLastCount'))
						this.data.totalTicksSinceLastCount = 0;

					if (Number.isNaN(this.data.totalTicksSinceLastCount))
						return (true);

					this.data.totalTicksSinceLastCount += ticks;
					//only accumulate counts up to cutoff
					cutoffTime = Math.round(1000 / this.data.frequencyCutoff);

					if (this.data.totalTicksSinceLastCount > cutoffTime) {
						this.data.frequency = 0;

						//Fire one event with 0 counts to indicate that the Timeout has elapsed and frequency is now 0
						this.onCountChange(0, this.data.totalTicksSinceLastCount);
						this.onFrequencyChange(this.data.frequency);

						this.data.totalTicksSinceLastCount = Number.NaN;
					}

					return (true);
				}

				// 1st count(s) since a timeout (or 1st read packet since opening)
				// don't try to calculate frequency because we don't know the 'ticks at first count'
				if (Number.isNaN(this.data.totalTicksSinceLastCount)) {
					this.data.totalTicksSinceLastCount = ticks - ticksAtLastCount;
					return (true);
				}

				countTimeSpan = this.data.totalTicksSinceLastCount + ticksAtLastCount; //in ms
				this.data.totalTicksSinceLastCount = ticks - ticksAtLastCount;

				d = this.data.frequencyCutoff;
				precision = 2;
				while (d < 1) {
					precision++;
					d *= 10;
				}

				this.data.frequency = Number((counts / (countTimeSpan / 1000.0)).toFixed(precision));

				this.onCountChange(counts, countTimeSpan);
				this.onFrequencyChange(this.data.frequency);
				return (true);
			}
		}

		FrequencyCounter.prototype.setFrequencyCutoff = function (frequencyCutoff) {

			this.data.frequencyCutoff = frequencyCutoff;
		};

		FrequencyCounter.prototype.resetCount = function () {
			this.data.count = 0;
			this.data.timeElapsed = 0;
			this.data.frequency = 1e300;
		};

		var Generic = function Generic() {
			Phidget.apply(this, arguments);
			this.name = "Generic";
			this.class = ChannelClass.GENERIC;

			this.onPacket = function (packet, packetLen) {};
			this.onError = function (code, desc) {};
		};
		Generic.prototype = Object.create(Phidget.prototype);
		Generic.prototype.constructor = Generic;
		self.Generic = Generic;

		Generic.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		Generic.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		Generic.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 0 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_PACKET:
				this.handlePacketEvent(bp);
				break;
			}
			return (true);
		};

		Generic.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			}
		}

		Generic.prototype.getINPacketLength = function() {

			this.checkOpen();

			return (this.data.INPacketLength);
		};

		Generic.prototype.getOUTPacketLength = function() {

			this.checkOpen();

			return (this.data.OUTPacketLength);
		};

		Generic.prototype.sendPacket = function(packet) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "c", value: packet });
			bp.set({ name: "1", type: "d", value: packetLen });
			return (bp.send(this.channel, BridgePackets.BP_SENDPACKET));
		};

		Generic.prototype.handlePacketEvent = function (bp) {

			var packet = bp.get("0");
			var packetLen = bp.get("1");

			this.onPacket(packet, packetLen);
		};


		var GPS = function GPS() {
			Phidget.apply(this, arguments);
			this.name = "GPS";
			this.class = ChannelClass.GPS;

			this.onPositionChange = function (latitude, longitude, altitude) {};
			this.onHeadingChange = function (heading, velocity) {};
			this.onPositionFixStateChange = function (positionFixState) {};
			this.onError = function (code, desc) {};
		};
		GPS.prototype = Object.create(Phidget.prototype);
		GPS.prototype.constructor = GPS;
		self.GPS = GPS;

		GPS.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		GPS.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		GPS.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 0 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_HEADINGCHANGE:
				this.handleHeadingChangeEvent(bp);
				break;
			case BridgePackets.BP_POSITIONCHANGE:
				this.handlePositionChangeEvent(bp);
				break;
			case BridgePackets.BP_POSITIONFIXSTATUSCHANGE:
				this.handlePositionFixStateChangeEvent(bp);
				break;
			}
			return (true);
		};

		GPS.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			}
		}

		GPS.prototype.getAltitude = function() {

			this.checkOpen();

			return (this.data.altitude);
		};

		GPS.prototype.getHeading = function() {

			this.checkOpen();

			return (this.data.heading);
		};

		GPS.prototype.getLatitude = function() {

			this.checkOpen();

			return (this.data.latitude);
		};

		GPS.prototype.getLongitude = function() {

			this.checkOpen();

			return (this.data.longitude);
		};

		GPS.prototype.getPositionFixState = function() {

			this.checkOpen();

			return (!!this.data.positionFixState);
		};

		GPS.prototype.getVelocity = function() {

			this.checkOpen();

			return (this.data.velocity);
		};

		GPS.prototype.handleHeadingChangeEvent = function (bp) {

			this.data.heading = bp.get("0");
			this.data.velocity = bp.get("1");

			this.onHeadingChange(this.data.heading, this.data.velocity);
		};

		GPS.prototype.handlePositionChangeEvent = function (bp) {

			this.data.latitude = bp.get("0");
			this.data.longitude = bp.get("1");
			this.data.altitude = bp.get("2");

			this.onPositionChange(this.data.latitude, this.data.longitude, this.data.altitude);
		};

		GPS.prototype.handlePositionFixStateChangeEvent = function (bp) {

			this.data.positionFixState = !!bp.get("0");

			this.onPositionFixStateChange(this.data.positionFixState);
		};

		GPS.prototype.handleUnsupportedBridgePacket = function handleUnsupportedBridgePacket(bp) {

			switch (bp.vpkt) {
			case BridgePackets.BP_DATA:
				// you can modify this section to pull less commonly used data out of the packet
				this.data["GPGGA.altitude"] = bp.entries["GPGGA.altitude"].v;
				this.data["GPGGA.latitude"] = bp.entries["GPGGA.latitude"].v;
				this.data["GPGGA.longitude"] = bp.entries["GPGGA.longitude"].v;
				this.data["GPVTG.speed"] = bp.entries["GPVTG.speed"].v;
				this.data["GPVTG.trueHeading"] = bp.entries["GPVTG.trueHeading"].v;

				this.data.altitude = bp.entries["GPGGA.altitude"].v;
				this.data.latitude = bp.entries["GPGGA.latitude"].v;
				this.data.longitude = bp.entries["GPGGA.longitude"].v;
				this.data.velocity = bp.entries["GPVTG.speed"].v;
				this.data.heading = bp.entries["GPVTG.trueHeading"].v;
				break;

			case BridgePackets.BP_TIME:
				var localHour = this.convertToLocal(bp.entries["GPSTime.tm_hour"].v);
				this.data["GPSTime.tm_ms"] = bp.entries["GPSTime.tm_ms"].v;
				this.data["GPSTime.tm_sec"] = bp.entries["GPSTime.tm_sec"].v;
				this.data["GPSTime.tm_min"] = bp.entries["GPSTime.tm_min"].v;
				this.data["GPSTime.tm_hour"] = localHour;
				if (typeof this.onTimeChange == 'function')
					this.onTimeChange(localHour, this.data["GPSTime.tm_min"], this.data["GPSTime.tm_sec"], this.data["GPSTime.tm_ms"]);
				break;

			case BridgePackets.BP_DATE:
				this.data["GPSDate.tm_mday"] = bp.entries["GPSDate.tm_mday"].v;
				this.data["GPSDate.tm_mon"] = bp.entries["GPSDate.tm_mon"].v;
				this.data["GPSDate.tm_year"] = bp.entries["GPSDate.tm_year"].v;
				if (typeof this.onDateChange == 'function')
					this.onDateChange(this.data["GPSDate.tm_year"], this.data["GPSDate.tm_mon"], this.data["GPSDate.tm_mday"]);
				break;

			default:
				return (false);
			}
			return (true);
		};

		GPS.prototype.convertToLocal = function convertToLocal(hour) {

			var d = new Date();
			var offset = d.getTimezoneOffset() / 60;
			return (hour - offset);
		};

		var Gyroscope = function Gyroscope() {
			Phidget.apply(this, arguments);
			this.name = "Gyroscope";
			this.class = ChannelClass.GYROSCOPE;

			this.onAngularRateUpdate = function (angularRate, timestamp) {};
			this.onError = function (code, desc) {};
		};
		Gyroscope.prototype = Object.create(Phidget.prototype);
		Gyroscope.prototype.constructor = Gyroscope;
		self.Gyroscope = Gyroscope;

		Gyroscope.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		Gyroscope.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		Gyroscope.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 2 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_ANGULARRATEUPDATE:
				this.handleAngularRateUpdateEvent(bp);
				break;
			}
			return (true);
		};

		Gyroscope.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETSPATIALPRECISION:
				this.data.precision =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Precision');
				return (true);
			}
		}

		Gyroscope.prototype.getAngularRate = function() {

			this.checkOpen();

			return (this.data.angularRate);
		};

		Gyroscope.prototype.getMinAngularRate = function() {

			this.checkOpen();

			return (this.data.minAngularRate);
		};

		Gyroscope.prototype.getMaxAngularRate = function() {

			this.checkOpen();

			return (this.data.maxAngularRate);
		};

		Gyroscope.prototype.getAxisCount = function() {

			this.checkOpen();

			return (this.data.axisCount);
		};

		Gyroscope.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		Gyroscope.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		Gyroscope.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		Gyroscope.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		Gyroscope.prototype.getPrecision = function() {

			this.checkOpen();

			return (this.data.precision);
		};

		Gyroscope.prototype.setPrecision = function(precision) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: precision });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETSPATIALPRECISION).then(function (res) {
				self.data.precision = precision;
			}));
		};

		Gyroscope.prototype.getTimestamp = function() {

			this.checkOpen();

			return (this.data.timestamp);
		};

		Gyroscope.prototype.zero = function() {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			return (bp.send(this.channel, BridgePackets.BP_ZERO));
		};

		Gyroscope.prototype.handleAngularRateUpdateEvent = function (bp) {

			this.data.angularRate = bp.get("0");
			this.data.timestamp = bp.get("1");

			this.onAngularRateUpdate(this.data.angularRate, this.data.timestamp);
		};


		var Hub = function Hub() {
			Phidget.apply(this, arguments);
			this.name = "Hub";
			this.class = ChannelClass.HUB;

			this.onError = function (code, desc) {};
		};
		Hub.prototype = Object.create(Phidget.prototype);
		Hub.prototype.constructor = Hub;
		self.Hub = Hub;

		Hub.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		Hub.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		Hub.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 0 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			}
			return (true);
		};

		Hub.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			}
		}

		Hub.prototype.setADCCalibrationValues = function(voltageInputGain, voltageRatioGain) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: voltageInputGain });
			bp.set({ name: "1", type: "g", value: voltageRatioGain });
			return (bp.send(this.channel, BridgePackets.BP_SETCALIBRATIONVALUES));
		};

		Hub.prototype.setFirmwareUpgradeFlag = function(port, timeout) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: port });
			bp.set({ name: "1", type: "u", value: timeout });
			return (bp.send(this.channel, BridgePackets.BP_SETFIRMWAREUPGRADEFLAG));
		};

		Hub.prototype.setPortMode = function(port, mode) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: port });
			bp.set({ name: "1", type: "d", value: mode });
			return (bp.send(this.channel, BridgePackets.BP_SETPORTMODE));
		};

		Hub.prototype.setPortPower = function(port, state) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: port });
			bp.set({ name: "1", type: "d", value: state });
			return (bp.send(this.channel, BridgePackets.BP_SETPORTPOWER));
		};


		var HumiditySensor = function HumiditySensor() {
			Phidget.apply(this, arguments);
			this.name = "HumiditySensor";
			this.class = ChannelClass.HUMIDITY_SENSOR;

			this.onHumidityChange = function (humidity) {};
			this.onError = function (code, desc) {};
		};
		HumiditySensor.prototype = Object.create(Phidget.prototype);
		HumiditySensor.prototype.constructor = HumiditySensor;
		self.HumiditySensor = HumiditySensor;

		HumiditySensor.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		HumiditySensor.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		HumiditySensor.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 0 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_HUMIDITYCHANGE:
				this.handleHumidityChangeEvent(bp);
				break;
			}
			return (true);
		};

		HumiditySensor.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETCHANGETRIGGER:
				this.data.humidityChangeTrigger =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('HumidityChangeTrigger');
				return (true);
			}
		}

		HumiditySensor.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		HumiditySensor.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		HumiditySensor.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		HumiditySensor.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		HumiditySensor.prototype.getHumidity = function() {

			this.checkOpen();

			return (this.data.humidity);
		};

		HumiditySensor.prototype.getMinHumidity = function() {

			this.checkOpen();

			return (this.data.minHumidity);
		};

		HumiditySensor.prototype.getMaxHumidity = function() {

			this.checkOpen();

			return (this.data.maxHumidity);
		};

		HumiditySensor.prototype.getHumidityChangeTrigger = function() {

			this.checkOpen();

			return (this.data.humidityChangeTrigger);
		};

		HumiditySensor.prototype.setHumidityChangeTrigger = function(humidityChangeTrigger) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: humidityChangeTrigger });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCHANGETRIGGER).then(function (res) {
				self.data.humidityChangeTrigger = humidityChangeTrigger;
			}));
		};

		HumiditySensor.prototype.getMinHumidityChangeTrigger = function() {

			this.checkOpen();

			return (this.data.minHumidityChangeTrigger);
		};

		HumiditySensor.prototype.getMaxHumidityChangeTrigger = function() {

			this.checkOpen();

			return (this.data.maxHumidityChangeTrigger);
		};

		HumiditySensor.prototype.handleHumidityChangeEvent = function (bp) {

			this.data.humidity = bp.get("0");

			this.onHumidityChange(this.data.humidity);
		};


		var IR = function IR() {
			Phidget.apply(this, arguments);
			this.name = "IR";
			this.class = ChannelClass.IR;

			this.onCode = function (code, bitCount, isRepeat) {};
			this.onLearn = function (code, codeInfo) {};
			this.onRawData = function (data, dataLen) {};
			this.onError = function (code, desc) {};
		};
		IR.prototype = Object.create(Phidget.prototype);
		IR.prototype.constructor = IR;
		self.IR = IR;

		IR.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		IR.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		IR.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 1 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_CODE:
				this.handleCodeEvent(bp);
				break;
			case BridgePackets.BP_LEARN:
				this.handleLearnEvent(bp);
				break;
			case BridgePackets.BP_RAWDATA:
				this.handleRawDataEvent(bp);
				break;
			}
			return (true);
		};

		self.RAW_DATA_LONG_SPACE = 4294967295;

		self.MAX_CODE_BIT_COUNT = 128;

		self.MAX_CODE_STRING_LENGTH = 33;

		IR.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			}
		}

		IR.prototype.transmit = function(code, codeInfo) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "s", value: code });
			bp.set({ name: "1", type: "J", value: codeInfo });
			return (bp.send(this.channel, BridgePackets.BP_TRANSMIT));
		};

		IR.prototype.transmitRaw = function(data, carrierFrequency, dutyCycle, gap) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: data });
			bp.set({ name: "1", type: "d", value: dataLen });
			bp.set({ name: "2", type: "u", value: carrierFrequency });
			bp.set({ name: "3", type: "g", value: dutyCycle });
			bp.set({ name: "4", type: "u", value: gap });
			return (bp.send(this.channel, BridgePackets.BP_TRANSMITRAW));
		};

		IR.prototype.transmitRepeat = function() {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			return (bp.send(this.channel, BridgePackets.BP_TRANSMITREPEAT));
		};

		IR.prototype.handleCodeEvent = function (bp) {

			var code = bp.get("0");
			var bitCount = bp.get("1");
			var isRepeat = !!bp.get("2");

			this.onCode(code, bitCount, isRepeat);
		};

		IR.prototype.handleLearnEvent = function (bp) {

			var code = bp.get("0");
			var codeInfo = {
				bitCount: bp.get("CodeInfo.bitCount"),
				encoding: bp.get("CodeInfo.encoding"),
				length: bp.get("CodeInfo.length"),
				gap: bp.get("CodeInfo.gap"),
				trail: bp.get("CodeInfo.trail"),
				header: bp.get("CodeInfo.header"),
				one: bp.get("CodeInfo.one"),
				zero: bp.get("CodeInfo.zero"),
				repeat: bp.get("CodeInfo.repeat"),
				minRepeat: bp.get("CodeInfo.minRepeat"),
				dutyCycle: bp.get("CodeInfo.dutyCycle"),
				carrierFrequency: bp.get("CodeInfo.carrierFrequency"),
				toggleMask: bp.get("CodeInfo.toggleMask"),
			};

			this.onLearn(code, codeInfo);
		};

		IR.prototype.handleRawDataEvent = function (bp) {

			var data = bp.get("0");
			var dataLen = bp.get("1");

			this.onRawData(data, dataLen);
		};

		IR.prototype.transmit = function(code, codeInfo, callback) {

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: 'code', type: 's', value: code });
			bp.set({ name: 'CodeInfo.bitCount', type: 'u', value: codeInfo.bitCount });
			bp.set({ name: 'CodeInfo.encoding', type: 'd', value: codeInfo.encoding });
			bp.set({ name: 'CodeInfo.length', type: 'd', value: codeInfo.length });
			bp.set({ name: 'CodeInfo.gap', type: 'u', value: codeInfo.gap });
			bp.set({ name: 'CodeInfo.trail', type: 'u', value: codeInfo.trail });
			bp.set({ name: 'CodeInfo.header', type: 'U', value: codeInfo.header });
			bp.set({ name: 'CodeInfo.one', type: 'U', value: codeInfo.one });
			bp.set({ name: 'CodeInfo.zero', type: 'U', value: codeInfo.zero });
			bp.set({ name: 'CodeInfo.repeat', type: 'U', value: codeInfo.repeat });
			bp.set({ name: 'CodeInfo.minRepeat', type: 'u', value: codeInfo.minRepeat });
			bp.set({ name: 'CodeInfo.dutyCycle', type: 'g', value: codeInfo.dutyCycle });
			bp.set({ name: 'CodeInfo.carrierFrequency', type: 'u', value: codeInfo.carrierFrequency });
			bp.set({ name: 'CodeInfo.toggleMask', type: 'R', value: codeInfo.toggleMask });
			bp.send(this.channel, BridgePackets.BP_TRANSMIT, callback);
		};

		IR.prototype.transmitRaw = function (data, carrierFrequency, dutyCycle, gap, callback) {

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: 'data', type: 'U', value: data });
			//bp.set({ name: 'count', type: 'u', value: data.length }); not needed in JS
			bp.set({ name: 'carrierFrequency', type: 'u', value: carrierFrequency });
			bp.set({ name: 'dutyCycle', type: 'g', value: dutyCycle });
			bp.set({ name: 'gap', type: 'u', value: gap });
			bp.send(this.channel, BridgePackets.BP_TRANSMITRAW, callback);
		}

		IR.prototype.handleCodeEvent = function (bp) {

			var code = bp.get("0");
			var bitCount = bp.get("1");
			var isRepeat = bp.get("2");
			var lastCodeInfo = { bitCount: bitCount };

			this.data.lastCodeStr = code;
			this.data.lastCodeInfo = lastCodeInfo;
			this.data.lastCodeKnown = true;

			this.onCode(code, bitCount, isRepeat);
		};

		IR.prototype.handleLearnEvent = function (bp) {

			var code = bp.get("0");
			var codeInfo = {
				bitCount: bp.get("CodeInfo.bitCount"),
				encoding: bp.get("CodeInfo.encoding"),
				length: bp.get("CodeInfo.length"),
				gap: bp.get("CodeInfo.gap"),
				trail: bp.get("CodeInfo.trail"),
				header: bp.get("CodeInfo.header"),
				one: bp.get("CodeInfo.one"),
				zero: bp.get("CodeInfo.zero"),
				repeat: bp.get("CodeInfo.repeat"),
				minRepeat: bp.get("CodeInfo.minRepeat"),
				dutyCycle: bp.get("CodeInfo.dutyCycle"),
				carrierFrequency: bp.get("CodeInfo.carrierFrequency"),
				toggleMask: bp.get("CodeInfo.toggleMask"),
			};

			this.data.lastLearnedCodeStr = code;
			this.data.lastLearnedCodeInfo = codeInfo;
			this.data.lastLearnedCodeKnown = true;
			this.onLearn(code, codeInfo);
		};

		IR.prototype.getLastCode = function () {

			if (typeof this.data.lastCodeKnown == "undefined")
				throw (new PhidgetError(ErrorCode.UNKNOWN_VALUE));
			else
				return ({ bitCount: this.data.lastCodeInfo.bitCount, code: this.data.lastCodeStr });
		};

		IR.prototype.getLastLearnedCode = function () {

			if (typeof this.data.lastLearnedCodeKnown == "undefined")
				throw (new PhidgetError(ErrorCode.UNKNOWN_VALUE));
			else
				return ({ code: this.data.lastLearnedCodeStr, codeInfo: this.data.lastLearnedCodeInfo });
		};

		IR.prototype.handleUnsupportedBridgePacket = function (bp) {

			switch (bp.vpkt) {
			case BridgePackets.BP_REPEAT:
				this.onCode(this.data.lastCodeStr, this.data.lastCodeStr.bitCount, true);
				break;
			default:
				return (false);
			}
			return (true);
		};

		var LCD = function LCD() {
			Phidget.apply(this, arguments);
			this.name = "LCD";
			this.class = ChannelClass.LCD;

			this.onError = function (code, desc) {};
		};
		LCD.prototype = Object.create(Phidget.prototype);
		LCD.prototype.constructor = LCD;
		self.LCD = LCD;

		LCD.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		LCD.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		LCD.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 2 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			}
			return (true);
		};

		LCD.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETBACKLIGHT:
				this.data.backlight =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Backlight');
				return (true);
			case BridgePackets.BP_SETCONTRAST:
				this.data.contrast =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Contrast');
				return (true);
			case BridgePackets.BP_SETCURSORBLINK:
				this.data.cursorBlink =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('CursorBlink');
				return (true);
			case BridgePackets.BP_SETCURSORON:
				this.data.cursorOn =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('CursorOn');
				return (true);
			case BridgePackets.BP_SETFRAMEBUFFER:
				this.data.frameBuffer =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('FrameBuffer');
				return (true);
			case BridgePackets.BP_SETSCREENSIZE:
				this.data.screenSize =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('ScreenSize');
				return (true);
			case BridgePackets.BP_SETSLEEP:
				this.data.sleeping =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Sleeping');
				return (true);
			}
		}

		LCD.prototype.getBacklight = function() {

			this.checkOpen();

			return (this.data.backlight);
		};

		LCD.prototype.setBacklight = function(backlight) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: backlight });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETBACKLIGHT).then(function (res) {
				self.data.backlight = backlight;
			}));
		};

		LCD.prototype.getMinBacklight = function() {

			this.checkOpen();

			return (this.data.minBacklight);
		};

		LCD.prototype.getMaxBacklight = function() {

			this.checkOpen();

			return (this.data.maxBacklight);
		};

		LCD.prototype.setCharacterBitmap = function(font, character, bitmap) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: font });
			bp.set({ name: "1", type: "s", value: character });
			bp.set({ name: "2", type: "c", value: bitmap });
			return (bp.send(this.channel, BridgePackets.BP_SETCHARACTERBITMAP));
		};

		LCD.prototype.clear = function() {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			return (bp.send(this.channel, BridgePackets.BP_CLEAR));
		};

		LCD.prototype.getContrast = function() {

			this.checkOpen();

			return (this.data.contrast);
		};

		LCD.prototype.setContrast = function(contrast) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: contrast });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCONTRAST).then(function (res) {
				self.data.contrast = contrast;
			}));
		};

		LCD.prototype.getMinContrast = function() {

			this.checkOpen();

			return (this.data.minContrast);
		};

		LCD.prototype.getMaxContrast = function() {

			this.checkOpen();

			return (this.data.maxContrast);
		};

		LCD.prototype.copy = function(sourceFramebuffer, destFramebuffer, sourceX1, sourceY1, sourceX2,
		  sourceY2, destX, destY, inverted) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: sourceFramebuffer });
			bp.set({ name: "1", type: "d", value: destFramebuffer });
			bp.set({ name: "2", type: "d", value: sourceX1 });
			bp.set({ name: "3", type: "d", value: sourceY1 });
			bp.set({ name: "4", type: "d", value: sourceX2 });
			bp.set({ name: "5", type: "d", value: sourceY2 });
			bp.set({ name: "6", type: "d", value: destX });
			bp.set({ name: "7", type: "d", value: destY });
			bp.set({ name: "8", type: "d", value: inverted });
			return (bp.send(this.channel, BridgePackets.BP_COPY));
		};

		LCD.prototype.getCursorBlink = function() {

			this.checkOpen();

			return (!!this.data.cursorBlink);
		};

		LCD.prototype.setCursorBlink = function(cursorBlink) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: cursorBlink });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCURSORBLINK).then(function (res) {
				self.data.cursorBlink = cursorBlink;
			}));
		};

		LCD.prototype.getCursorOn = function() {

			this.checkOpen();

			return (!!this.data.cursorOn);
		};

		LCD.prototype.setCursorOn = function(cursorOn) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: cursorOn });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCURSORON).then(function (res) {
				self.data.cursorOn = cursorOn;
			}));
		};

		LCD.prototype.drawLine = function(x1, y1, x2, y2) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: x1 });
			bp.set({ name: "1", type: "d", value: y1 });
			bp.set({ name: "2", type: "d", value: x2 });
			bp.set({ name: "3", type: "d", value: y2 });
			return (bp.send(this.channel, BridgePackets.BP_DRAWLINE));
		};

		LCD.prototype.drawPixel = function(x, y, pixelState) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: x });
			bp.set({ name: "1", type: "d", value: y });
			bp.set({ name: "2", type: "d", value: pixelState });
			return (bp.send(this.channel, BridgePackets.BP_DRAWPIXEL));
		};

		LCD.prototype.drawRect = function(x1, y1, x2, y2, filled, inverted) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: x1 });
			bp.set({ name: "1", type: "d", value: y1 });
			bp.set({ name: "2", type: "d", value: x2 });
			bp.set({ name: "3", type: "d", value: y2 });
			bp.set({ name: "4", type: "d", value: filled });
			bp.set({ name: "5", type: "d", value: inverted });
			return (bp.send(this.channel, BridgePackets.BP_DRAWRECT));
		};

		LCD.prototype.flush = function() {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			return (bp.send(this.channel, BridgePackets.BP_FLUSH));
		};

		LCD.prototype.setFontSize = function(font, width, height) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: font });
			bp.set({ name: "1", type: "d", value: width });
			bp.set({ name: "2", type: "d", value: height });
			return (bp.send(this.channel, BridgePackets.BP_SETFONTSIZE));
		};

		LCD.prototype.getFrameBuffer = function() {

			this.checkOpen();

			return (this.data.frameBuffer);
		};

		LCD.prototype.setFrameBuffer = function(frameBuffer) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: frameBuffer });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETFRAMEBUFFER).then(function (res) {
				self.data.frameBuffer = frameBuffer;
			}));
		};

		LCD.prototype.getHeight = function() {

			this.checkOpen();

			return (this.data.height);
		};

		LCD.prototype.initialize = function() {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			return (bp.send(this.channel, BridgePackets.BP_INITIALIZE));
		};

		LCD.prototype.saveFrameBuffer = function(frameBuffer) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: frameBuffer });
			return (bp.send(this.channel, BridgePackets.BP_SAVEFRAMEBUFFER));
		};

		LCD.prototype.getScreenSize = function() {

			this.checkOpen();

			return (this.data.screenSize);
		};

		LCD.prototype.setScreenSize = function(screenSize) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: screenSize });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETSCREENSIZE).then(function (res) {
				self.data.screenSize = screenSize;
			}));
		};

		LCD.prototype.getSleeping = function() {

			this.checkOpen();

			return (!!this.data.sleeping);
		};

		LCD.prototype.setSleeping = function(sleeping) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: sleeping });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETSLEEP).then(function (res) {
				self.data.sleeping = sleeping;
			}));
		};

		LCD.prototype.getWidth = function() {

			this.checkOpen();

			return (this.data.width);
		};

		LCD.prototype.writeBitmap = function(xPosition, yPosition, xSize, ySize, bitmap) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: xPosition });
			bp.set({ name: "1", type: "d", value: yPosition });
			bp.set({ name: "2", type: "d", value: xSize });
			bp.set({ name: "3", type: "d", value: ySize });
			bp.set({ name: "4", type: "c", value: bitmap });
			return (bp.send(this.channel, BridgePackets.BP_WRITEBITMAP));
		};

		LCD.prototype.writeText = function(font, xPosition, yPosition, text) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: font });
			bp.set({ name: "1", type: "d", value: xPosition });
			bp.set({ name: "2", type: "d", value: yPosition });
			bp.set({ name: "3", type: "s", value: text });
			return (bp.send(this.channel, BridgePackets.BP_WRITETEXT));
		};

		LCD.prototype.handleUnsupportedBridgePacket = function (bp) {

			switch (bp.vpkt) {
				default:
					return (false);
				case BridgePackets.BP_SETFONTSIZE:
					var font = bp.get("0");
					var width = bp.get("1");
					var height = bp.get("2");
					this.data.fontWidth[parseInt(font)] = width;
					this.data.fontHeight[parseInt(font)] = height;
					if (this.onPropertyChange)
						this.onPropertyChange('FontSize');
					return (true);
			}
		}

		LCD.prototype.setCharacterBitmap = function (font, character, bitmap) {

			var fontSize = this.getFontSize(font);
			var bp = new BridgePacket(this.channel.conn);

			if (fontSize.width <= 0)
				return Promise.reject(new PhidgetError(ErrorCode.INVALIDARG, "invalid arg (getFontSize): " + font));
			if (fontSize.height <= 0)
				return Promise.reject(new PhidgetError(ErrorCode.INVALIDARG, "invalid arg (getFontSize): " + font));

			bp.set({ name: "font", type: "d", value: font });
			bp.set({ name: "character", type: "s", value: character });
			bp.set({ name: "bitmap", type: "R", value: bitmap });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCHARACTERBITMAP, function () {
				if (typeof self.setCharacterBitmapSuccess === "function")
					self.setCharacterBitmapSuccess();
			}.bind(this)));
		};

		LCD.prototype.getMaxCharacters = function (font) {

			var maxChars;
			var fontSize;

			switch (this.getDeviceID()) {
				case DeviceID.PN_LCD1100:
					if (parseInt(font) < 1 || parseInt(font) > 5)
						throw (new PhidgetError(ErrorCode.INVALIDARG, "invalid arg (getMaxCharacters): " + font));

					fontSize = this.getFontSize(font);

					if (fontSize.width <= 0)
						throw (new PhidgetError(ErrorCode.INVALIDARG, "invalid arg (getFontSize): " + font));

					if (fontSize.height <= 0)
						throw (new PhidgetError(ErrorCode.INVALIDARG, "invalid arg (getFontSize): " + font));

					maxChars = Math.min(255, (this.data.width / fontSize.width) * (this.data.height / fontSize.height));
					break;

				case DeviceID.PN_1202_1203:
				case DeviceID.PN_1204:
				case DeviceID.PN_1215__1218:
				case DeviceID.PN_1219__1222:
					maxChars = 0xff;
					break;

				default:
					throw (new PhidgetError(ErrorCode.UNEXPECTED));
			}

			return (maxChars);
		};

		LCD.prototype.getFontSize = function (font) {

			var fontSize = { width: 0, height: 0 };

			var v = window;

			switch (parseInt(font)) {
				case LCDFont.DIMENSIONS_6X10:
					fontSize.width = 6;
					fontSize.height = 10;
					break;
				case LCDFont.DIMENSIONS_5X8:
					fontSize.width = 5;
					fontSize.height = 8;
					break;
				case LCDFont.DIMENSIONS_6X12:
					fontSize.width = 6;
					fontSize.height = 12;
					break;
				case LCDFont.USER1:
				case LCDFont.USER2:
					fontSize.width = this.data.fontWidth[parseInt(font)];
					fontSize.height = this.data.fontHeight[parseInt(font)];
					break;
				default:
					throw (new PhidgetError(ErrorCode.INVALIDARG, "invalid arg (getFontSize): " + font));
			}

			return (fontSize);
		};

		LCD.prototype.setFontSize = function (font, width, height) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: font });
			bp.set({ name: "1", type: "d", value: width });
			bp.set({ name: "2", type: "d", value: height });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETFONTSIZE).then(function (res) {
				self.data.fontWidth[font] = width;
				self.data.fontHeight[font] = height;
			}));
		};

		LCD.prototype.writeBitmap = function (xpos, ypos, xsize, ysize, bitmap) {

			var bp = new BridgePacket(this.channel.conn);

			if (xsize <= 0 || ysize <= 0)
				return Promise.reject(new PhidgetError(ErrorCode.INVALIDARG, "invalid arg (size cannot be <=0) " + font));

			bp.set({ name: "xpos", type: "d", value: xpos });
			bp.set({ name: "ypos", type: "d", value: ypos });
			bp.set({ name: "xsize", type: "d", value: xsize });
			bp.set({ name: "ysize", type: "d", value: ysize });
			bp.set({ name: "bitmap", type: "R", value: bitmap });

			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_WRITEBITMAP, function () {
				if (typeof self.setCharacterBitmapSuccess === "function")
					self.setCharacterBitmapSuccess();
			}.bind(this)));
		};

		var LightSensor = function LightSensor() {
			Phidget.apply(this, arguments);
			this.name = "LightSensor";
			this.class = ChannelClass.LIGHT_SENSOR;

			this.onIlluminanceChange = function (illuminance) {};
			this.onError = function (code, desc) {};
		};
		LightSensor.prototype = Object.create(Phidget.prototype);
		LightSensor.prototype.constructor = LightSensor;
		self.LightSensor = LightSensor;

		LightSensor.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		LightSensor.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		LightSensor.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 0 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_ILLUMINANCECHANGE:
				this.handleIlluminanceChangeEvent(bp);
				break;
			}
			return (true);
		};

		LightSensor.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETCHANGETRIGGER:
				this.data.illuminanceChangeTrigger =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('IlluminanceChangeTrigger');
				return (true);
			}
		}

		LightSensor.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		LightSensor.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		LightSensor.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		LightSensor.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		LightSensor.prototype.getIlluminance = function() {

			this.checkOpen();

			return (this.data.illuminance);
		};

		LightSensor.prototype.getMinIlluminance = function() {

			this.checkOpen();

			return (this.data.minIlluminance);
		};

		LightSensor.prototype.getMaxIlluminance = function() {

			this.checkOpen();

			return (this.data.maxIlluminance);
		};

		LightSensor.prototype.getIlluminanceChangeTrigger = function() {

			this.checkOpen();

			return (this.data.illuminanceChangeTrigger);
		};

		LightSensor.prototype.setIlluminanceChangeTrigger = function(illuminanceChangeTrigger) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: illuminanceChangeTrigger });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCHANGETRIGGER).then(function (res) {
				self.data.illuminanceChangeTrigger = illuminanceChangeTrigger;
			}));
		};

		LightSensor.prototype.getMinIlluminanceChangeTrigger = function() {

			this.checkOpen();

			return (this.data.minIlluminanceChangeTrigger);
		};

		LightSensor.prototype.getMaxIlluminanceChangeTrigger = function() {

			this.checkOpen();

			return (this.data.maxIlluminanceChangeTrigger);
		};

		LightSensor.prototype.handleIlluminanceChangeEvent = function (bp) {

			this.data.illuminance = bp.get("0");

			this.onIlluminanceChange(this.data.illuminance);
		};


		var Magnetometer = function Magnetometer() {
			Phidget.apply(this, arguments);
			this.name = "Magnetometer";
			this.class = ChannelClass.MAGNETOMETER;

			this.onMagneticFieldChange = function (magneticField, timestamp) {};
			this.onError = function (code, desc) {};
		};
		Magnetometer.prototype = Object.create(Phidget.prototype);
		Magnetometer.prototype.constructor = Magnetometer;
		self.Magnetometer = Magnetometer;

		Magnetometer.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		Magnetometer.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		Magnetometer.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 1 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_FIELDSTRENGTHCHANGE:
				this.handleMagneticFieldChangeEvent(bp);
				break;
			}
			return (true);
		};

		Magnetometer.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETCHANGETRIGGER:
				this.data.magneticFieldChangeTrigger =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('MagneticFieldChangeTrigger');
				return (true);
			}
		}

		Magnetometer.prototype.getAxisCount = function() {

			this.checkOpen();

			return (this.data.axisCount);
		};

		Magnetometer.prototype.setCorrectionParameters = function(magneticField, offset0, offset1,
		  offset2, gain0, gain1, gain2, T0, T1, T2, T3, T4, T5) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: magneticField });
			bp.set({ name: "1", type: "g", value: offset0 });
			bp.set({ name: "2", type: "g", value: offset1 });
			bp.set({ name: "3", type: "g", value: offset2 });
			bp.set({ name: "4", type: "g", value: gain0 });
			bp.set({ name: "5", type: "g", value: gain1 });
			bp.set({ name: "6", type: "g", value: gain2 });
			bp.set({ name: "7", type: "g", value: T0 });
			bp.set({ name: "8", type: "g", value: T1 });
			bp.set({ name: "9", type: "g", value: T2 });
			bp.set({ name: "10", type: "g", value: T3 });
			bp.set({ name: "11", type: "g", value: T4 });
			bp.set({ name: "12", type: "g", value: T5 });
			return (bp.send(this.channel, BridgePackets.BP_SETCORRECTIONPARAMETERS));
		};

		Magnetometer.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		Magnetometer.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		Magnetometer.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		Magnetometer.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		Magnetometer.prototype.getMagneticField = function() {

			this.checkOpen();

			return (this.data.magneticField);
		};

		Magnetometer.prototype.getMinMagneticField = function() {

			this.checkOpen();

			return (this.data.minMagneticField);
		};

		Magnetometer.prototype.getMaxMagneticField = function() {

			this.checkOpen();

			return (this.data.maxMagneticField);
		};

		Magnetometer.prototype.getMagneticFieldChangeTrigger = function() {

			this.checkOpen();

			return (this.data.magneticFieldChangeTrigger);
		};

		Magnetometer.prototype.setMagneticFieldChangeTrigger = function(magneticFieldChangeTrigger) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: magneticFieldChangeTrigger });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCHANGETRIGGER).then(function (res) {
				self.data.magneticFieldChangeTrigger = magneticFieldChangeTrigger;
			}));
		};

		Magnetometer.prototype.getMinMagneticFieldChangeTrigger = function() {

			this.checkOpen();

			return (this.data.minMagneticFieldChangeTrigger);
		};

		Magnetometer.prototype.getMaxMagneticFieldChangeTrigger = function() {

			this.checkOpen();

			return (this.data.maxMagneticFieldChangeTrigger);
		};

		Magnetometer.prototype.resetCorrectionParameters = function() {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			return (bp.send(this.channel, BridgePackets.BP_RESETCORRECTIONPARAMETERS));
		};

		Magnetometer.prototype.saveCorrectionParameters = function() {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			return (bp.send(this.channel, BridgePackets.BP_SAVECORRECTIONPARAMETERS));
		};

		Magnetometer.prototype.getTimestamp = function() {

			this.checkOpen();

			return (this.data.timestamp);
		};

		Magnetometer.prototype.handleMagneticFieldChangeEvent = function (bp) {

			this.data.magneticField = bp.get("0");
			this.data.timestamp = bp.get("1");

			this.onMagneticFieldChange(this.data.magneticField, this.data.timestamp);
		};


		var MotorPositionController = function MotorPositionController() {
			Phidget.apply(this, arguments);
			this.name = "MotorPositionController";
			this.class = ChannelClass.MOTOR_POSITION_CONTROLLER;

			this.onPositionChange = function (position) {};
			this.onDutyCycleUpdate = function (dutyCycle) {};
			this.onError = function (code, desc) {};
		};
		MotorPositionController.prototype = Object.create(Phidget.prototype);
		MotorPositionController.prototype.constructor = MotorPositionController;
		self.MotorPositionController = MotorPositionController;

		MotorPositionController.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		MotorPositionController.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		MotorPositionController.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 0 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_DUTYCYCLECHANGE:
				this.handleDutyCycleUpdateEvent(bp);
				break;
			case BridgePackets.BP_POSITIONCHANGE:
				this.handlePositionChangeEvent(bp);
				break;
			}
			return (true);
		};

		MotorPositionController.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETACCELERATION:
				this.data.acceleration =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Acceleration');
				return (true);
			case BridgePackets.BP_SETCURRENTLIMIT:
				this.data.currentLimit =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('CurrentLimit');
				return (true);
			case BridgePackets.BP_SETCURRENTREGULATORGAIN:
				this.data.currentRegulatorGain =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('CurrentRegulatorGain');
				return (true);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETDEADBAND:
				this.data.deadBand =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DeadBand');
				return (true);
			case BridgePackets.BP_SETENGAGED:
				this.data.engaged =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Engaged');
				return (true);
			case BridgePackets.BP_SETFANMODE:
				this.data.fanMode =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('FanMode');
				return (true);
			case BridgePackets.BP_SETIOMODE:
				this.data.IOMode =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('IOMode');
				return (true);
			case BridgePackets.BP_SETKD:
				this.data.kd =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Kd');
				return (true);
			case BridgePackets.BP_SETKI:
				this.data.ki =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Ki');
				return (true);
			case BridgePackets.BP_SETKP:
				this.data.kp =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Kp');
				return (true);
			case BridgePackets.BP_SETSTALLVELOCITY:
				this.data.stallVelocity =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('StallVelocity');
				return (true);
			case BridgePackets.BP_SETTARGETPOSITION:
				this.data.targetPosition =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('TargetPosition');
				return (true);
			case BridgePackets.BP_SETDUTYCYCLE:
				this.data.velocityLimit =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('VelocityLimit');
				return (true);
			}
		}

		MotorPositionController.prototype.getAcceleration = function() {

			this.checkOpen();

			return (this.data.acceleration);
		};

		MotorPositionController.prototype.setAcceleration = function(acceleration) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: acceleration });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETACCELERATION).then(function (res) {
				self.data.acceleration = acceleration;
			}));
		};

		MotorPositionController.prototype.getMinAcceleration = function() {

			this.checkOpen();

			return (this.data.minAcceleration);
		};

		MotorPositionController.prototype.getMaxAcceleration = function() {

			this.checkOpen();

			return (this.data.maxAcceleration);
		};

		MotorPositionController.prototype.getCurrentLimit = function() {

			this.checkOpen();

			return (this.data.currentLimit);
		};

		MotorPositionController.prototype.setCurrentLimit = function(currentLimit) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: currentLimit });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCURRENTLIMIT).then(function (res) {
				self.data.currentLimit = currentLimit;
			}));
		};

		MotorPositionController.prototype.getMinCurrentLimit = function() {

			this.checkOpen();

			return (this.data.minCurrentLimit);
		};

		MotorPositionController.prototype.getMaxCurrentLimit = function() {

			this.checkOpen();

			return (this.data.maxCurrentLimit);
		};

		MotorPositionController.prototype.getCurrentRegulatorGain = function() {

			this.checkOpen();

			return (this.data.currentRegulatorGain);
		};

		MotorPositionController.prototype.setCurrentRegulatorGain = function(currentRegulatorGain) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: currentRegulatorGain });
			var self = this;
			return (bp.send(this.channel,
			  BridgePackets.BP_SETCURRENTREGULATORGAIN).then(function (res) {
				self.data.currentRegulatorGain = currentRegulatorGain;
			}));
		};

		MotorPositionController.prototype.getMinCurrentRegulatorGain = function() {

			this.checkOpen();

			return (this.data.minCurrentRegulatorGain);
		};

		MotorPositionController.prototype.getMaxCurrentRegulatorGain = function() {

			this.checkOpen();

			return (this.data.maxCurrentRegulatorGain);
		};

		MotorPositionController.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		MotorPositionController.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		MotorPositionController.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		MotorPositionController.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		MotorPositionController.prototype.getDeadBand = function() {

			this.checkOpen();

			return (this.data.deadBand);
		};

		MotorPositionController.prototype.setDeadBand = function(deadBand) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: deadBand });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDEADBAND).then(function (res) {
				self.data.deadBand = deadBand;
			}));
		};

		MotorPositionController.prototype.getDutyCycle = function() {

			this.checkOpen();

			return (this.data.dutyCycle);
		};

		MotorPositionController.prototype.getEngaged = function() {

			this.checkOpen();

			return (!!this.data.engaged);
		};

		MotorPositionController.prototype.setEngaged = function(engaged) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: engaged });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETENGAGED).then(function (res) {
				self.data.engaged = engaged;
			}));
		};

		MotorPositionController.prototype.getFanMode = function() {

			this.checkOpen();

			return (this.data.fanMode);
		};

		MotorPositionController.prototype.setFanMode = function(fanMode) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: fanMode });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETFANMODE).then(function (res) {
				self.data.fanMode = fanMode;
			}));
		};

		MotorPositionController.prototype.getIOMode = function() {

			this.checkOpen();

			return (this.data.IOMode);
		};

		MotorPositionController.prototype.setIOMode = function(IOMode) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: IOMode });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETIOMODE).then(function (res) {
				self.data.IOMode = IOMode;
			}));
		};

		MotorPositionController.prototype.getKd = function() {

			this.checkOpen();

			return (this.data.kd);
		};

		MotorPositionController.prototype.setKd = function(kd) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: kd });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETKD).then(function (res) {
				self.data.kd = kd;
			}));
		};

		MotorPositionController.prototype.getKi = function() {

			this.checkOpen();

			return (this.data.ki);
		};

		MotorPositionController.prototype.setKi = function(ki) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: ki });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETKI).then(function (res) {
				self.data.ki = ki;
			}));
		};

		MotorPositionController.prototype.getKp = function() {

			this.checkOpen();

			return (this.data.kp);
		};

		MotorPositionController.prototype.setKp = function(kp) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: kp });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETKP).then(function (res) {
				self.data.kp = kp;
			}));
		};

		MotorPositionController.prototype.getPosition = function() {

			this.checkOpen();

			return (this.data.position);
		};

		MotorPositionController.prototype.getMinPosition = function() {

			this.checkOpen();

			return (this.data.minPosition);
		};

		MotorPositionController.prototype.getMaxPosition = function() {

			this.checkOpen();

			return (this.data.maxPosition);
		};

		MotorPositionController.prototype.getRescaleFactor = function() {

			this.checkOpen();

			return (this.data.rescaleFactor);
		};

		MotorPositionController.prototype.getStallVelocity = function() {

			this.checkOpen();

			return (this.data.stallVelocity);
		};

		MotorPositionController.prototype.setStallVelocity = function(stallVelocity) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: stallVelocity });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETSTALLVELOCITY).then(function (res) {
				self.data.stallVelocity = stallVelocity;
			}));
		};

		MotorPositionController.prototype.getMinStallVelocity = function() {

			this.checkOpen();

			return (this.data.minStallVelocity);
		};

		MotorPositionController.prototype.getMaxStallVelocity = function() {

			this.checkOpen();

			return (this.data.maxStallVelocity);
		};

		MotorPositionController.prototype.getTargetPosition = function() {

			this.checkOpen();

			return (this.data.targetPosition);
		};

		MotorPositionController.prototype.setTargetPosition = function(targetPosition) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "l", value: targetPosition });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETTARGETPOSITION).then(function (res) {
				self.data.targetPosition = targetPosition;
			}));
		};

		MotorPositionController.prototype.getVelocityLimit = function() {

			this.checkOpen();

			return (this.data.velocityLimit);
		};

		MotorPositionController.prototype.setVelocityLimit = function(velocityLimit) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: velocityLimit });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDUTYCYCLE).then(function (res) {
				self.data.velocityLimit = velocityLimit;
			}));
		};

		MotorPositionController.prototype.getMinVelocityLimit = function() {

			this.checkOpen();

			return (this.data.minVelocityLimit);
		};

		MotorPositionController.prototype.getMaxVelocityLimit = function() {

			this.checkOpen();

			return (this.data.maxVelocityLimit);
		};

		MotorPositionController.prototype.handleDutyCycleUpdateEvent = function (bp) {

			this.data.dutyCycle = bp.get("0");

			this.onDutyCycleUpdate(this.data.dutyCycle);
		};

		MotorPositionController.prototype.handlePositionChangeEvent = function (bp) {

			this.data.position = bp.get("0");

			this.onPositionChange(this.data.position);
		};

		MotorPositionController.prototype.getAcceleration = function() {

			if (this.data.acceleration == 1e300)
				throw (new PhidgetError(ErrorCode.UNKNOWN_VALUE));
			else
				return (this.data.acceleration * this.data.rescaleFactor);
		};

		MotorPositionController.prototype.setAcceleration = function(acceleration) {

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "acceleration", type: "g", value: acceleration });
			bp.send(this.channel, BridgePackets.BP_SETACCELERATION, function () {
				this.data.acceleration = acceleration / this.data.rescaleFactor;
				if (typeof this.setAccelerationSuccess === "function")
					this.setAccelerationSuccess(acceleration);
			}.bind(this));
		};

		MotorPositionController.prototype.getMinAcceleration = function() {

			return (this.data.minAcceleration * this.data.rescaleFactor);
		};

		MotorPositionController.prototype.getMaxAcceleration = function() {

			return (this.data.maxAcceleration * this.data.rescaleFactor);
		};

		MotorPositionController.prototype.addPositionOffset = function(positionOffset) {

			this.data.positionOffset += (positionOffset / this.data.rescaleFactor);
		};

		MotorPositionController.prototype.getDeadBand = function() {

			return (this.data.deadBand * this.data.rescaleFactor);
		};

		MotorPositionController.prototype.setDeadBand = function(deadBand) {

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "deadBand", type: "u", value: deadBand });
			bp.send(this.channel, BridgePackets.BP_SETDEADBAND, function () {
				this.data.deadBand = deadBand / this.data.rescaleFactor;
				if (typeof this.setDeadBandSuccess === "function")
					this.setDeadBandSuccess(deadBand);
			}.bind(this));
		};

		MotorPositionController.prototype.getPosition = function() {

			return ((this.data.position + this.data.positionOffset) * this.data.rescaleFactor);
		};

		MotorPositionController.prototype.getMinPosition = function() {

			return ((this.data.minPosition + this.data.positionOffset) * this.data.rescaleFactor);
		};

		MotorPositionController.prototype.getMaxPosition = function() {

			return ((this.data.maxPosition + this.data.positionOffset) * this.data.rescaleFactor);
		};

		MotorPositionController.prototype.setRescaleFactor = function(rescaleFactor) {

			this.data.rescaleFactor = rescaleFactor;
		};

		MotorPositionController.prototype.getTargetPosition = function() {

			return ((this.data.targetPosition + this.data.positionOffset) * this.data.rescaleFactor);
		};

		MotorPositionController.prototype.setTargetPosition = function(targetPosition) {

			var calcPosition = (targetPosition / this.data.rescaleFactor) - this.data.positionOffset;
			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "targetPosition", type: "l", value: calcPosition });

			bp.send(this.channel, BridgePackets.BP_SETTARGETPOSITION).then(function () {
				this.data.targetPosition = calcPosition;
				if (typeof this.setTargetPositionSuccess === "function")
					this.setTargetPositionSuccess(calcPosition);
			}.bind(this));
		};

		MotorPositionController.prototype.getVelocityLimit = function() {

			return (this.data.velocityLimit * this.data.rescaleFactor);
		};

		MotorPositionController.prototype.getStallVelocity = function() {

			return (this.data.stallVelocity * this.data.rescaleFactor);
		};

		MotorPositionController.prototype.setStallVelocity = function(stallVelocity) {

			var calcVelocity = stallVelocity / this.data.rescaleFactor;
			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "stallVelocity", type: "g", value: calcVelocity });
			bp.send(this.channel, BridgePackets.BP_SETSTALLVELOCITY, function () {
				this.data.stallVelocity = calcVelocity;
				if (typeof this.setStallVelocitySuccess === "function")
					this.setStallVelocitySuccess(calcVelocity);
			}.bind(this));
		};

		MotorPositionController.prototype.setVelocityLimit = function(velocityLimit) {

			var calcLimit = velocityLimit / this.data.rescaleFactor;
			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "velocityLimit", type: "g", value: calcLimit });
			bp.send(this.channel, BridgePackets.BP_SETDUTYCYCLE, function () {
				this.data.velocityLimit = calcLimit;
				if (typeof this.setVelocityLimitSuccess === "function")
					this.setVelocityLimitSuccess(calcLimit);
			}.bind(this));
		};

		MotorPositionController.prototype.getMinStallVelocity = function() {

			return (this.data.minStallVelocity * this.data.rescaleFactor);
		};

		MotorPositionController.prototype.getMaxStallVelocity = function() {

			return (this.data.maxStallVelocity * this.data.rescaleFactor);
		};

		MotorPositionController.prototype.getMinVelocityLimit = function() {

			return (this.data.minVelocityLimit * this.data.rescaleFactor);
		};

		MotorPositionController.prototype.getMaxVelocityLimit = function() {

			return (this.data.maxVelocityLimit * this.data.rescaleFactor);
		};

		MotorPositionController.prototype.handlePositionChangeEvent = function (bp) {

			this.data.position = bp.get("0");
			this.onPositionChange((this.data.position + this.data.positionOffset) * this.data.rescaleFactor);
		};

		var PHSensor = function PHSensor() {
			Phidget.apply(this, arguments);
			this.name = "PHSensor";
			this.class = ChannelClass.PH_SENSOR;

			this.onPHChange = function (PH) {};
			this.onError = function (code, desc) {};
		};
		PHSensor.prototype = Object.create(Phidget.prototype);
		PHSensor.prototype.constructor = PHSensor;
		self.PHSensor = PHSensor;

		PHSensor.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		PHSensor.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		PHSensor.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 0 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_PHCHANGE:
				this.handlePHChangeEvent(bp);
				break;
			}
			return (true);
		};

		PHSensor.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETCORRECTIONTEMPERATURE:
				this.data.correctionTemperature =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('CorrectionTemperature');
				return (true);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETCHANGETRIGGER:
				this.data.PHChangeTrigger =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('PHChangeTrigger');
				return (true);
			}
		}

		PHSensor.prototype.getCorrectionTemperature = function() {

			this.checkOpen();

			return (this.data.correctionTemperature);
		};

		PHSensor.prototype.setCorrectionTemperature = function(correctionTemperature) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: correctionTemperature });
			var self = this;
			return (bp.send(this.channel,
			  BridgePackets.BP_SETCORRECTIONTEMPERATURE).then(function (res) {
				self.data.correctionTemperature = correctionTemperature;
			}));
		};

		PHSensor.prototype.getMinCorrectionTemperature = function() {

			this.checkOpen();

			return (this.data.minCorrectionTemperature);
		};

		PHSensor.prototype.getMaxCorrectionTemperature = function() {

			this.checkOpen();

			return (this.data.maxCorrectionTemperature);
		};

		PHSensor.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		PHSensor.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		PHSensor.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		PHSensor.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		PHSensor.prototype.getPH = function() {

			this.checkOpen();

			return (this.data.PH);
		};

		PHSensor.prototype.getMinPH = function() {

			this.checkOpen();

			return (this.data.minPH);
		};

		PHSensor.prototype.getMaxPH = function() {

			this.checkOpen();

			return (this.data.maxPH);
		};

		PHSensor.prototype.getPHChangeTrigger = function() {

			this.checkOpen();

			return (this.data.PHChangeTrigger);
		};

		PHSensor.prototype.setPHChangeTrigger = function(PHChangeTrigger) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: PHChangeTrigger });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCHANGETRIGGER).then(function (res) {
				self.data.PHChangeTrigger = PHChangeTrigger;
			}));
		};

		PHSensor.prototype.getMinPHChangeTrigger = function() {

			this.checkOpen();

			return (this.data.minPHChangeTrigger);
		};

		PHSensor.prototype.getMaxPHChangeTrigger = function() {

			this.checkOpen();

			return (this.data.maxPHChangeTrigger);
		};

		PHSensor.prototype.handlePHChangeEvent = function (bp) {

			this.data.PH = bp.get("0");

			this.onPHChange(this.data.PH);
		};


		var PowerGuard = function PowerGuard() {
			Phidget.apply(this, arguments);
			this.name = "PowerGuard";
			this.class = ChannelClass.POWER_GUARD;

			this.onError = function (code, desc) {};
		};
		PowerGuard.prototype = Object.create(Phidget.prototype);
		PowerGuard.prototype.constructor = PowerGuard;
		self.PowerGuard = PowerGuard;

		PowerGuard.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		PowerGuard.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		PowerGuard.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 0 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			}
			return (true);
		};

		PowerGuard.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETFANMODE:
				this.data.fanMode =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('FanMode');
				return (true);
			case BridgePackets.BP_SETOVERVOLTAGE:
				this.data.overVoltage =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('OverVoltage');
				return (true);
			case BridgePackets.BP_SETENABLED:
				this.data.powerEnabled =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('PowerEnabled');
				return (true);
			}
		}

		PowerGuard.prototype.getFanMode = function() {

			this.checkOpen();

			return (this.data.fanMode);
		};

		PowerGuard.prototype.setFanMode = function(fanMode) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: fanMode });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETFANMODE).then(function (res) {
				self.data.fanMode = fanMode;
			}));
		};

		PowerGuard.prototype.getOverVoltage = function() {

			this.checkOpen();

			return (this.data.overVoltage);
		};

		PowerGuard.prototype.setOverVoltage = function(overVoltage) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: overVoltage });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETOVERVOLTAGE).then(function (res) {
				self.data.overVoltage = overVoltage;
			}));
		};

		PowerGuard.prototype.getMinOverVoltage = function() {

			this.checkOpen();

			return (this.data.minOverVoltage);
		};

		PowerGuard.prototype.getMaxOverVoltage = function() {

			this.checkOpen();

			return (this.data.maxOverVoltage);
		};

		PowerGuard.prototype.getPowerEnabled = function() {

			this.checkOpen();

			return (!!this.data.powerEnabled);
		};

		PowerGuard.prototype.setPowerEnabled = function(powerEnabled) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: powerEnabled });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETENABLED).then(function (res) {
				self.data.powerEnabled = powerEnabled;
			}));
		};


		var PressureSensor = function PressureSensor() {
			Phidget.apply(this, arguments);
			this.name = "PressureSensor";
			this.class = ChannelClass.PRESSURE_SENSOR;

			this.onPressureChange = function (pressure) {};
			this.onError = function (code, desc) {};
		};
		PressureSensor.prototype = Object.create(Phidget.prototype);
		PressureSensor.prototype.constructor = PressureSensor;
		self.PressureSensor = PressureSensor;

		PressureSensor.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		PressureSensor.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		PressureSensor.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 0 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_PRESSURECHANGE:
				this.handlePressureChangeEvent(bp);
				break;
			}
			return (true);
		};

		PressureSensor.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETCHANGETRIGGER:
				this.data.pressureChangeTrigger =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('PressureChangeTrigger');
				return (true);
			}
		}

		PressureSensor.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		PressureSensor.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		PressureSensor.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		PressureSensor.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		PressureSensor.prototype.getPressure = function() {

			this.checkOpen();

			return (this.data.pressure);
		};

		PressureSensor.prototype.getMinPressure = function() {

			this.checkOpen();

			return (this.data.minPressure);
		};

		PressureSensor.prototype.getMaxPressure = function() {

			this.checkOpen();

			return (this.data.maxPressure);
		};

		PressureSensor.prototype.getPressureChangeTrigger = function() {

			this.checkOpen();

			return (this.data.pressureChangeTrigger);
		};

		PressureSensor.prototype.setPressureChangeTrigger = function(pressureChangeTrigger) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: pressureChangeTrigger });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCHANGETRIGGER).then(function (res) {
				self.data.pressureChangeTrigger = pressureChangeTrigger;
			}));
		};

		PressureSensor.prototype.getMinPressureChangeTrigger = function() {

			this.checkOpen();

			return (this.data.minPressureChangeTrigger);
		};

		PressureSensor.prototype.getMaxPressureChangeTrigger = function() {

			this.checkOpen();

			return (this.data.maxPressureChangeTrigger);
		};

		PressureSensor.prototype.handlePressureChangeEvent = function (bp) {

			this.data.pressure = bp.get("0");

			this.onPressureChange(this.data.pressure);
		};


		var RCServo = function RCServo() {
			Phidget.apply(this, arguments);
			this.name = "RCServo";
			this.class = ChannelClass.RC_SERVO;

			this.onPositionChange = function (position) {};
			this.onVelocityChange = function (velocity) {};
			this.onTargetPositionReached = function (position) {};
			this.onError = function (code, desc) {};
		};
		RCServo.prototype = Object.create(Phidget.prototype);
		RCServo.prototype.constructor = RCServo;
		self.RCServo = RCServo;

		RCServo.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		RCServo.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		RCServo.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 3 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_POSITIONCHANGE:
				this.handlePositionChangeEvent(bp);
				break;
			case BridgePackets.BP_TARGETPOSITIONREACHED:
				this.handleTargetPositionReachedEvent(bp);
				break;
			case BridgePackets.BP_VELOCITYCHANGE:
				this.handleVelocityChangeEvent(bp);
				break;
			}
			return (true);
		};

		RCServo.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETACCELERATION:
				this.data.acceleration =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Acceleration');
				return (true);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETENGAGED:
				this.data.engaged =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Engaged');
				return (true);
			case BridgePackets.BP_SETMINPULSEWIDTH:
				this.data.minPulseWidth =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('MinPulseWidth');
				return (true);
			case BridgePackets.BP_SETMAXPULSEWIDTH:
				this.data.maxPulseWidth =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('MaxPulseWidth');
				return (true);
			case BridgePackets.BP_SETSPEEDRAMPINGSTATE:
				this.data.speedRampingState =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('SpeedRampingState');
				return (true);
			case BridgePackets.BP_SETTARGETPOSITION:
				this.data.targetPosition =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('TargetPosition');
				return (true);
			case BridgePackets.BP_SETDUTYCYCLE:
				this.data.torque =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Torque');
				return (true);
			case BridgePackets.BP_SETVELOCITYLIMIT:
				this.data.velocityLimit =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('VelocityLimit');
				return (true);
			case BridgePackets.BP_SETVOLTAGE:
				this.data.voltage =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Voltage');
				return (true);
			}
		}

		RCServo.prototype.getAcceleration = function() {

			this.checkOpen();

			return (this.data.acceleration);
		};

		RCServo.prototype.setAcceleration = function(acceleration) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: acceleration });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETACCELERATION).then(function (res) {
				self.data.acceleration = acceleration;
			}));
		};

		RCServo.prototype.getMinAcceleration = function() {

			this.checkOpen();

			return (this.data.minAcceleration);
		};

		RCServo.prototype.getMaxAcceleration = function() {

			this.checkOpen();

			return (this.data.maxAcceleration);
		};

		RCServo.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		RCServo.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		RCServo.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		RCServo.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		RCServo.prototype.getEngaged = function() {

			this.checkOpen();

			return (!!this.data.engaged);
		};

		RCServo.prototype.setEngaged = function(engaged) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: engaged });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETENGAGED).then(function (res) {
				self.data.engaged = engaged;
			}));
		};

		RCServo.prototype.getIsMoving = function() {

			this.checkOpen();

			return (!!this.data.isMoving);
		};

		RCServo.prototype.getPosition = function() {

			this.checkOpen();

			return (this.data.position);
		};

		RCServo.prototype.getMinPosition = function() {

			this.checkOpen();

			return (this.data.minPosition);
		};

		RCServo.prototype.getMaxPosition = function() {

			this.checkOpen();

			return (this.data.maxPosition);
		};

		RCServo.prototype.setMinPulseWidth = function(minPulseWidth) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: minPulseWidth });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETMINPULSEWIDTH).then(function (res) {
				self.data.minPulseWidth = minPulseWidth;
			}));
		};

		RCServo.prototype.getMinPulseWidth = function() {

			this.checkOpen();

			return (this.data.minPulseWidth);
		};

		RCServo.prototype.setMaxPulseWidth = function(maxPulseWidth) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: maxPulseWidth });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETMAXPULSEWIDTH).then(function (res) {
				self.data.maxPulseWidth = maxPulseWidth;
			}));
		};

		RCServo.prototype.getMaxPulseWidth = function() {

			this.checkOpen();

			return (this.data.maxPulseWidth);
		};

		RCServo.prototype.getMinPulseWidthLimit = function() {

			this.checkOpen();

			return (this.data.minPulseWidthLimit);
		};

		RCServo.prototype.getMaxPulseWidthLimit = function() {

			this.checkOpen();

			return (this.data.maxPulseWidthLimit);
		};

		RCServo.prototype.getSpeedRampingState = function() {

			this.checkOpen();

			return (!!this.data.speedRampingState);
		};

		RCServo.prototype.setSpeedRampingState = function(speedRampingState) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: speedRampingState });
			var self = this;
			return (bp.send(this.channel,
			  BridgePackets.BP_SETSPEEDRAMPINGSTATE).then(function (res) {
				self.data.speedRampingState = speedRampingState;
			}));
		};

		RCServo.prototype.getTargetPosition = function() {

			this.checkOpen();

			return (this.data.targetPosition);
		};

		RCServo.prototype.setTargetPosition = function(targetPosition) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: targetPosition });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETTARGETPOSITION).then(function (res) {
				self.data.targetPosition = targetPosition;
			}));
		};

		RCServo.prototype.getTorque = function() {

			this.checkOpen();

			return (this.data.torque);
		};

		RCServo.prototype.setTorque = function(torque) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: torque });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDUTYCYCLE).then(function (res) {
				self.data.torque = torque;
			}));
		};

		RCServo.prototype.getMinTorque = function() {

			this.checkOpen();

			return (this.data.minTorque);
		};

		RCServo.prototype.getMaxTorque = function() {

			this.checkOpen();

			return (this.data.maxTorque);
		};

		RCServo.prototype.getVelocity = function() {

			this.checkOpen();

			return (this.data.velocity);
		};

		RCServo.prototype.getVelocityLimit = function() {

			this.checkOpen();

			return (this.data.velocityLimit);
		};

		RCServo.prototype.setVelocityLimit = function(velocityLimit) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: velocityLimit });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETVELOCITYLIMIT).then(function (res) {
				self.data.velocityLimit = velocityLimit;
			}));
		};

		RCServo.prototype.getMinVelocityLimit = function() {

			this.checkOpen();

			return (this.data.minVelocityLimit);
		};

		RCServo.prototype.getMaxVelocityLimit = function() {

			this.checkOpen();

			return (this.data.maxVelocityLimit);
		};

		RCServo.prototype.getVoltage = function() {

			this.checkOpen();

			return (this.data.voltage);
		};

		RCServo.prototype.setVoltage = function(voltage) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: voltage });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETVOLTAGE).then(function (res) {
				self.data.voltage = voltage;
			}));
		};

		RCServo.prototype.handlePositionChangeEvent = function (bp) {

			this.data.position = bp.get("0");

			this.onPositionChange(this.data.position);
		};

		RCServo.prototype.handleTargetPositionReachedEvent = function (bp) {

			this.data.position = bp.get("0");

			this.onTargetPositionReached(this.data.position);
		};

		RCServo.prototype.handleVelocityChangeEvent = function (bp) {

			this.data.velocity = bp.get("0");

			this.onVelocityChange(this.data.velocity);
		};

		RCServo.prototype.positionUser = function(position_us) {

			return (this.data.minPosition +
			  ((position_us - this.data.minPulseWidth) / (this.data.maxPulseWidth - this.data.minPulseWidth)) *
			  this.data.maxPosition - this.data.minPosition);
		}

		RCServo.prototype.positionUS = function(position_user) {


			if (this.data.maxPosition > this.data.minPosition)
				return (this.data.minPulseWidth +
				  ((this.data.maxPulseWidth - this.data.minPulseWidth) *
				   (position_user - this.data.minPosition)) /
				  (this.data.maxPosition - this.data.minPosition));

			return (this.data.maxPulseWidth +
			  ((this.data.maxPulseWidth - this.data.minPulseWidth) *
			   (position_user - this.data.maxPosition)) /
			  (this.data.maxPosition - this.data.minPosition));
		}

		RCServo.prototype.velocityUser = function(velocity_us) {

			return ((Math.abs((this.data.maxPosition - this.data.minPosition)) * velocity_us) /
			  (this.data.maxPulseWidth - this.data.minPulseWidth));
		}
		RCServo.prototype.velocityUS = function(velocity_user) {

			return (((this.data.maxPulseWidth - this.data.minPulseWidth) * velocity_user) /
				Math.abs(this.data.maxPosition - this.data.minPosition));
		}
		RCServo.prototype.accelUser = function(accel_us) {

			return (((Math.abs((this.data.maxPosition - this.data.minPosition)) * accel_us) /
			  (this.data.maxPulseWidth - this.data.minPulseWidth)));
		}

		RCServo.prototype.accelUS = function(accel_user) {

			return (((this.data.maxPulseWidth - this.data.minPulseWidth) * accel_user) /
			  Math.abs(this.data.maxPosition - this.data.minPosition));
		}

		RCServo.prototype.getAcceleration = function() {

			return (this.accelUser(this.data.acceleration));
		};

		RCServo.prototype.getMinAcceleration = function() {

			return (this.accelUser(this.data.minAcceleration));
		};

		RCServo.prototype.getMaxAcceleration = function() {

			return (this.accelUser(this.data.maxAcceleration));
		};

		RCServo.prototype.getPosition = function() {

			return (this.positionUser(this.data.position));
		};

		RCServo.prototype.setMaxPosition = function(maxPosition) {

			this.data.maxPosition = maxPosition;
		};

		RCServo.prototype.setMinPosition = function(minPosition) {

			this.data.minPosition = minPosition;
		};

		RCServo.prototype.getTargetPosition = function() {

			return (this.positionUser(this.data.targetPosition));
		};

		RCServo.prototype.getVelocity = function() {

			return (this.velocityUser(this.data.velocity));
		};

		RCServo.prototype.getMinVelocity = function() {

			return (this.velocityUser(this.data.minVelocity));
		};

		RCServo.prototype.getMaxVelocity = function() {

			return (this.velocityUser(this.data.maxVelocity));
		};

		RCServo.prototype.getVelocityLimit = function() {

			return (this.velocityUser(this.data.velocityLimit));
		};

		RCServo.prototype.getMinVelocityLimit = function() {

			return (this.velocityUser(this.data.minVelocityLimit));
		};

		RCServo.prototype.getMaxVelocityLimit = function() {

			return (this.velocityUser(this.data.maxVelocityLimit));
		};

		RCServo.prototype.setAcceleration = function(acceleration) {

			var self = this;

			acceleration = this.accelUS(acceleration);
			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "acceleration", type: "g", value: acceleration });
			return (bp.send(this.channel, BridgePackets.BP_SETACCELERATION).then(function () {
				self.data.acceleration = acceleration;
			}));
		};

		RCServo.prototype.setTargetPosition = function(targetPosition) {

			var self = this;

			targetPosition = this.positionUS(targetPosition);
			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "targetPosition", type: "g", value: targetPosition });
			return (bp.send(this.channel, BridgePackets.BP_SETTARGETPOSITION).then(function () {
				self.data.targetPosition = targetPosition;
				if (self.getEngaged() === true && self.getVelocityLimit() !== 0 && self.getPosition() !== self.getTargetPosition())
					self.data.isMoving = true;
			}));
		};

		RCServo.prototype.setVelocityLimit = function(velocityLimit) {

			var self = this;

			velocityLimit = this.velocityUS(velocityLimit);
			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "velocityLimit", type: "g", value: velocityLimit });
			return (bp.send(this.channel, BridgePackets.BP_SETVELOCITYLIMIT).then(function () {
				self.data.velocityLimit = velocityLimit;
			}));
		};

		RCServo.prototype.handlePositionChangeEvent = function (bp) {

			this.data.position = bp.get("0");
			this.onPositionChange(this.positionUser(this.data.position));
		};

		RCServo.prototype.handleTargetPositionReachedEvent = function (bp) {

			this.data.position = bp.get("0");
			this.data.isMoving = false;
			this.onTargetPositionReached(this.positionUser(this.data.position));
		};

		RCServo.prototype.handleVelocityChangeEvent = function (bp) {

			this.data.velocity = bp.get("0");
			this.onVelocityChange(this.velocityUser(this.data.velocity));
		};

		var ResistanceInput = function ResistanceInput() {
			Phidget.apply(this, arguments);
			this.name = "ResistanceInput";
			this.class = ChannelClass.RESISTANCE_INPUT;

			this.onResistanceChange = function (resistance) {};
			this.onError = function (code, desc) {};
		};
		ResistanceInput.prototype = Object.create(Phidget.prototype);
		ResistanceInput.prototype.constructor = ResistanceInput;
		self.ResistanceInput = ResistanceInput;

		ResistanceInput.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		ResistanceInput.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		ResistanceInput.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 0 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_RESISTANCECHANGE:
				this.handleResistanceChangeEvent(bp);
				break;
			}
			return (true);
		};

		ResistanceInput.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETCHANGETRIGGER:
				this.data.resistanceChangeTrigger =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('ResistanceChangeTrigger');
				return (true);
			case BridgePackets.BP_SETRTDWIRESETUP:
				this.data.RTDWireSetup =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('RTDWireSetup');
				return (true);
			}
		}

		ResistanceInput.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		ResistanceInput.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		ResistanceInput.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		ResistanceInput.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		ResistanceInput.prototype.getResistance = function() {

			this.checkOpen();

			return (this.data.resistance);
		};

		ResistanceInput.prototype.getMinResistance = function() {

			this.checkOpen();

			return (this.data.minResistance);
		};

		ResistanceInput.prototype.getMaxResistance = function() {

			this.checkOpen();

			return (this.data.maxResistance);
		};

		ResistanceInput.prototype.getResistanceChangeTrigger = function() {

			this.checkOpen();

			return (this.data.resistanceChangeTrigger);
		};

		ResistanceInput.prototype.setResistanceChangeTrigger = function(resistanceChangeTrigger) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: resistanceChangeTrigger });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCHANGETRIGGER).then(function (res) {
				self.data.resistanceChangeTrigger = resistanceChangeTrigger;
			}));
		};

		ResistanceInput.prototype.getMinResistanceChangeTrigger = function() {

			this.checkOpen();

			return (this.data.minResistanceChangeTrigger);
		};

		ResistanceInput.prototype.getMaxResistanceChangeTrigger = function() {

			this.checkOpen();

			return (this.data.maxResistanceChangeTrigger);
		};

		ResistanceInput.prototype.getRTDWireSetup = function() {

			this.checkOpen();

			return (this.data.RTDWireSetup);
		};

		ResistanceInput.prototype.setRTDWireSetup = function(RTDWireSetup) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: RTDWireSetup });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETRTDWIRESETUP).then(function (res) {
				self.data.RTDWireSetup = RTDWireSetup;
			}));
		};

		ResistanceInput.prototype.handleResistanceChangeEvent = function (bp) {

			this.data.resistance = bp.get("0");

			this.onResistanceChange(this.data.resistance);
		};


		var RFID = function RFID() {
			Phidget.apply(this, arguments);
			this.name = "RFID";
			this.class = ChannelClass.RFID;

			this.onTag = function (Tag, Protocol) {};
			this.onTagLost = function (Tag, Protocol) {};
			this.onError = function (code, desc) {};
		};
		RFID.prototype = Object.create(Phidget.prototype);
		RFID.prototype.constructor = RFID;
		self.RFID = RFID;

		RFID.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		RFID.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		RFID.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 1 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_TAG:
				this.handleTagEvent(bp);
				break;
			case BridgePackets.BP_TAGLOST:
				this.handleTagLostEvent(bp);
				break;
			}
			return (true);
		};

		RFID.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETANTENNAON:
				this.data.antennaEnabled =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('AntennaEnabled');
				return (true);
			}
		}

		RFID.prototype.getAntennaEnabled = function() {

			this.checkOpen();

			return (!!this.data.antennaEnabled);
		};

		RFID.prototype.setAntennaEnabled = function(antennaEnabled) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: antennaEnabled });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETANTENNAON).then(function (res) {
				self.data.antennaEnabled = antennaEnabled;
			}));
		};

		RFID.prototype.getTagPresent = function() {

			this.checkOpen();

			return (!!this.data.tagPresent);
		};

		RFID.prototype.write = function(tagString, protocol, lockTag) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "s", value: tagString });
			bp.set({ name: "1", type: "d", value: protocol });
			bp.set({ name: "2", type: "d", value: lockTag });
			return (bp.send(this.channel, BridgePackets.BP_WRITE));
		};

		RFID.prototype.handleTagEvent = function (bp) {

			var tag = bp.get("0");
			var protocol = bp.get("1");

			this.onTag(tag, protocol);
		};

		RFID.prototype.handleTagLostEvent = function (bp) {

			var tag = bp.get("0");
			var protocol = bp.get("1");

			this.onTagLost(tag, protocol);
		};

		RFID.prototype.handleUnsupportedBridgePacket = function handleUnsupportedBridgePacket(bp) {

			switch (bp.vpkt) {
				case BridgePackets.BP_TAG:
					this.data.tagPresent = true;
					this.handleTagEvent(bp);
					this.data.lastTagString = bp.get("0");
					this.data.lastTagProtocol = bp.get("1");
					break;

				case BridgePackets.BP_TAGLOST:
					this.data.tagPresent = false;
					this.handleTagLostEvent(bp);
					break;

				default:
					return (false);
			}
			return (true);
		};

		RFID.prototype.getLastTag = function() {
			this.checkOpen();

			if (this.data.lastTagProtocol === undefined)
				throw (new PhidgetError(ErrorCode.UNKNOWN_VALUE));

			return ({
				tagString: this.data.lastTagString,
				protocol: this.data.lastTagProtocol
			});
		};

		var SoundSensor = function SoundSensor() {
			Phidget.apply(this, arguments);
			this.name = "SoundSensor";
			this.class = ChannelClass.SOUND_SENSOR;

			this.onSPLChange = function (dB, dBA, dBC, Octaves) {};
			this.onError = function (code, desc) {};
		};
		SoundSensor.prototype = Object.create(Phidget.prototype);
		SoundSensor.prototype.constructor = SoundSensor;
		self.SoundSensor = SoundSensor;

		SoundSensor.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		SoundSensor.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		SoundSensor.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 1 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_DBCHANGE:
				this.handleSPLChangeEvent(bp);
				break;
			}
			return (true);
		};

		SoundSensor.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETCHANGETRIGGER:
				this.data.SPLChangeTrigger =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('SPLChangeTrigger');
				return (true);
			case BridgePackets.BP_SETSPLRANGE:
				this.data.SPLRange =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('SPLRange');
				return (true);
			}
		}

		SoundSensor.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		SoundSensor.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		SoundSensor.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		SoundSensor.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		SoundSensor.prototype.getdB = function() {

			this.checkOpen();

			return (this.data.dB);
		};

		SoundSensor.prototype.getMaxdB = function() {

			this.checkOpen();

			return (this.data.maxdB);
		};

		SoundSensor.prototype.getdBA = function() {

			this.checkOpen();

			return (this.data.dBA);
		};

		SoundSensor.prototype.getdBC = function() {

			this.checkOpen();

			return (this.data.dBC);
		};

		SoundSensor.prototype.getNoiseFloor = function() {

			this.checkOpen();

			return (this.data.noiseFloor);
		};

		SoundSensor.prototype.getOctaves = function() {

			this.checkOpen();

			return (this.data.octaves);
		};

		SoundSensor.prototype.getSPLChangeTrigger = function() {

			this.checkOpen();

			return (this.data.SPLChangeTrigger);
		};

		SoundSensor.prototype.setSPLChangeTrigger = function(SPLChangeTrigger) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: SPLChangeTrigger });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCHANGETRIGGER).then(function (res) {
				self.data.SPLChangeTrigger = SPLChangeTrigger;
			}));
		};

		SoundSensor.prototype.getMinSPLChangeTrigger = function() {

			this.checkOpen();

			return (this.data.minSPLChangeTrigger);
		};

		SoundSensor.prototype.getMaxSPLChangeTrigger = function() {

			this.checkOpen();

			return (this.data.maxSPLChangeTrigger);
		};

		SoundSensor.prototype.getSPLRange = function() {

			this.checkOpen();

			return (this.data.SPLRange);
		};

		SoundSensor.prototype.setSPLRange = function(SPLRange) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: SPLRange });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETSPLRANGE).then(function (res) {
				self.data.SPLRange = SPLRange;
			}));
		};

		SoundSensor.prototype.handleSPLChangeEvent = function (bp) {

			this.data.dB = bp.get("0");
			this.data.dBA = bp.get("1");
			this.data.dBC = bp.get("2");
			this.data.octaves = bp.get("3");

			this.onSPLChange(this.data.dB, this.data.dBA, this.data.dBC, this.data.octaves);
		};


		var Spatial = function Spatial() {
			Phidget.apply(this, arguments);
			this.name = "Spatial";
			this.class = ChannelClass.SPATIAL;

			this.onSpatialData = function (acceleration, angularRate, magneticField, timestamp) {};
			this.onAlgorithmData = function (quaternion, timestamp) {};
			this.onError = function (code, desc) {};
		};
		Spatial.prototype = Object.create(Phidget.prototype);
		Spatial.prototype.constructor = Spatial;
		self.Spatial = Spatial;

		Spatial.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		Spatial.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		Spatial.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 3 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_SPATIALALGDATA:
				this.handleAlgorithmDataEvent(bp);
				break;
			case BridgePackets.BP_SPATIALDATA:
				this.handleSpatialDataEvent(bp);
				break;
			}
			return (true);
		};

		Spatial.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSPATIALALGORITHM:
				this.data.algorithm =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Algorithm');
				return (true);
			case BridgePackets.BP_SETSPATIALALGORITHMMAGGAIN:
				this.data.algorithmMagnetometerGain =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('AlgorithmMagnetometerGain');
				return (true);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETSPATIALPRECISION:
				this.data.precision =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Precision');
				return (true);
			}
		}

		Spatial.prototype.getAlgorithm = function() {

			this.checkOpen();

			return (this.data.algorithm);
		};

		Spatial.prototype.setAlgorithm = function(algorithm) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: algorithm });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETSPATIALALGORITHM).then(function (res) {
				self.data.algorithm = algorithm;
			}));
		};

		Spatial.prototype.getAlgorithmMagnetometerGain = function() {

			this.checkOpen();

			return (this.data.algorithmMagnetometerGain);
		};

		Spatial.prototype.setAlgorithmMagnetometerGain = function(algorithmMagnetometerGain) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: algorithmMagnetometerGain });
			var self = this;
			return (bp.send(this.channel,
			  BridgePackets.BP_SETSPATIALALGORITHMMAGGAIN).then(function (res) {
				self.data.algorithmMagnetometerGain = algorithmMagnetometerGain;
			}));
		};

		Spatial.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		Spatial.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		Spatial.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		Spatial.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		Spatial.prototype.setMagnetometerCorrectionParameters = function(magneticField, offset0,
		  offset1, offset2, gain0, gain1, gain2, T0, T1, T2, T3, T4, T5) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: magneticField });
			bp.set({ name: "1", type: "g", value: offset0 });
			bp.set({ name: "2", type: "g", value: offset1 });
			bp.set({ name: "3", type: "g", value: offset2 });
			bp.set({ name: "4", type: "g", value: gain0 });
			bp.set({ name: "5", type: "g", value: gain1 });
			bp.set({ name: "6", type: "g", value: gain2 });
			bp.set({ name: "7", type: "g", value: T0 });
			bp.set({ name: "8", type: "g", value: T1 });
			bp.set({ name: "9", type: "g", value: T2 });
			bp.set({ name: "10", type: "g", value: T3 });
			bp.set({ name: "11", type: "g", value: T4 });
			bp.set({ name: "12", type: "g", value: T5 });
			return (bp.send(this.channel, BridgePackets.BP_SETCORRECTIONPARAMETERS));
		};

		Spatial.prototype.getPrecision = function() {

			this.checkOpen();

			return (this.data.precision);
		};

		Spatial.prototype.setPrecision = function(precision) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: precision });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETSPATIALPRECISION).then(function (res) {
				self.data.precision = precision;
			}));
		};

		Spatial.prototype.resetMagnetometerCorrectionParameters = function() {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			return (bp.send(this.channel, BridgePackets.BP_RESETCORRECTIONPARAMETERS));
		};

		Spatial.prototype.saveMagnetometerCorrectionParameters = function() {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			return (bp.send(this.channel, BridgePackets.BP_SAVECORRECTIONPARAMETERS));
		};

		Spatial.prototype.zeroAlgorithm = function() {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			return (bp.send(this.channel, BridgePackets.BP_ZEROSPATIALALGORITHM));
		};

		Spatial.prototype.zeroGyro = function() {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			return (bp.send(this.channel, BridgePackets.BP_ZERO));
		};

		Spatial.prototype.handleAlgorithmDataEvent = function (bp) {

			var quaternion = bp.get("0");
			var timestamp = bp.get("1");

			this.onAlgorithmData(quaternion, timestamp);
		};

		Spatial.prototype.handleSpatialDataEvent = function (bp) {

			var acceleration = bp.get("0");
			var angularRate = bp.get("1");
			var magneticField = bp.get("2");
			var timestamp = bp.get("3");

			this.onSpatialData(acceleration, angularRate, magneticField, timestamp);
		};


		var Stepper = function Stepper() {
			Phidget.apply(this, arguments);
			this.name = "Stepper";
			this.class = ChannelClass.STEPPER;

			this.onPositionChange = function (position) {};
			this.onVelocityChange = function (velocity) {};
			this.onStopped = function () {};
			this.onError = function (code, desc) {};
		};
		Stepper.prototype = Object.create(Phidget.prototype);
		Stepper.prototype.constructor = Stepper;
		self.Stepper = Stepper;

		Stepper.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		Stepper.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		Stepper.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 2 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_POSITIONCHANGE:
				this.handlePositionChangeEvent(bp);
				break;
			case BridgePackets.BP_STOPPED:
				this.handleStoppedEvent(bp);
				break;
			case BridgePackets.BP_VELOCITYCHANGE:
				this.handleVelocityChangeEvent(bp);
				break;
			}
			return (true);
		};

		Stepper.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETACCELERATION:
				this.data.acceleration =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Acceleration');
				return (true);
			case BridgePackets.BP_SETCONTROLMODE:
				this.data.controlMode =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('ControlMode');
				return (true);
			case BridgePackets.BP_SETCURRENTLIMIT:
				this.data.currentLimit =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('CurrentLimit');
				return (true);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETENGAGED:
				this.data.engaged =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Engaged');
				return (true);
			case BridgePackets.BP_SETHOLDINGCURRENTLIMIT:
				this.data.holdingCurrentLimit =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('HoldingCurrentLimit');
				return (true);
			case BridgePackets.BP_SETTARGETPOSITION:
				this.data.targetPosition =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('TargetPosition');
				return (true);
			case BridgePackets.BP_SETVELOCITYLIMIT:
				this.data.velocityLimit =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('VelocityLimit');
				return (true);
			}
		}

		Stepper.prototype.getAcceleration = function() {

			this.checkOpen();

			return (this.data.acceleration);
		};

		Stepper.prototype.setAcceleration = function(acceleration) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: acceleration });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETACCELERATION).then(function (res) {
				self.data.acceleration = acceleration;
			}));
		};

		Stepper.prototype.getMinAcceleration = function() {

			this.checkOpen();

			return (this.data.minAcceleration);
		};

		Stepper.prototype.getMaxAcceleration = function() {

			this.checkOpen();

			return (this.data.maxAcceleration);
		};

		Stepper.prototype.getControlMode = function() {

			this.checkOpen();

			return (this.data.controlMode);
		};

		Stepper.prototype.setControlMode = function(controlMode) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: controlMode });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCONTROLMODE).then(function (res) {
				self.data.controlMode = controlMode;
			}));
		};

		Stepper.prototype.getCurrentLimit = function() {

			this.checkOpen();

			return (this.data.currentLimit);
		};

		Stepper.prototype.setCurrentLimit = function(currentLimit) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: currentLimit });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCURRENTLIMIT).then(function (res) {
				self.data.currentLimit = currentLimit;
			}));
		};

		Stepper.prototype.getMinCurrentLimit = function() {

			this.checkOpen();

			return (this.data.minCurrentLimit);
		};

		Stepper.prototype.getMaxCurrentLimit = function() {

			this.checkOpen();

			return (this.data.maxCurrentLimit);
		};

		Stepper.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		Stepper.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		Stepper.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		Stepper.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		Stepper.prototype.getEngaged = function() {

			this.checkOpen();

			return (!!this.data.engaged);
		};

		Stepper.prototype.setEngaged = function(engaged) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: engaged });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETENGAGED).then(function (res) {
				self.data.engaged = engaged;
			}));
		};

		Stepper.prototype.getHoldingCurrentLimit = function() {

			this.checkOpen();

			return (this.data.holdingCurrentLimit);
		};

		Stepper.prototype.setHoldingCurrentLimit = function(holdingCurrentLimit) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: holdingCurrentLimit });
			var self = this;
			return (bp.send(this.channel,
			  BridgePackets.BP_SETHOLDINGCURRENTLIMIT).then(function (res) {
				self.data.holdingCurrentLimit = holdingCurrentLimit;
			}));
		};

		Stepper.prototype.getIsMoving = function() {

			this.checkOpen();

			return (!!this.data.isMoving);
		};

		Stepper.prototype.getPosition = function() {

			this.checkOpen();

			return (this.data.position);
		};

		Stepper.prototype.getMinPosition = function() {

			this.checkOpen();

			return (this.data.minPosition);
		};

		Stepper.prototype.getMaxPosition = function() {

			this.checkOpen();

			return (this.data.maxPosition);
		};

		Stepper.prototype.getRescaleFactor = function() {

			this.checkOpen();

			return (this.data.rescaleFactor);
		};

		Stepper.prototype.getTargetPosition = function() {

			this.checkOpen();

			return (this.data.targetPosition);
		};

		Stepper.prototype.setTargetPosition = function(targetPosition) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "l", value: targetPosition });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETTARGETPOSITION).then(function (res) {
				self.data.targetPosition = targetPosition;
			}));
		};

		Stepper.prototype.getVelocity = function() {

			this.checkOpen();

			return (this.data.velocity);
		};

		Stepper.prototype.getVelocityLimit = function() {

			this.checkOpen();

			return (this.data.velocityLimit);
		};

		Stepper.prototype.setVelocityLimit = function(velocityLimit) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: velocityLimit });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETVELOCITYLIMIT).then(function (res) {
				self.data.velocityLimit = velocityLimit;
			}));
		};

		Stepper.prototype.getMinVelocityLimit = function() {

			this.checkOpen();

			return (this.data.minVelocityLimit);
		};

		Stepper.prototype.getMaxVelocityLimit = function() {

			this.checkOpen();

			return (this.data.maxVelocityLimit);
		};

		Stepper.prototype.handlePositionChangeEvent = function (bp) {

			this.data.position = bp.get("0");

			this.onPositionChange(this.data.position);
		};

		Stepper.prototype.handleStoppedEvent = function (bp) {


			this.onStopped();
		};

		Stepper.prototype.handleVelocityChangeEvent = function (bp) {

			this.data.velocity = bp.get("0");

			this.onVelocityChange(this.data.velocity);
		};

		Stepper.prototype.getAcceleration = function() {

			if (this.data.acceleration == 1e300)
				throw (new PhidgetError(ErrorCode.UNKNOWN_VALUE));
			else
				return (this.data.acceleration * this.data.rescaleFactor);
		};

		Stepper.prototype.setAcceleration = function(acceleration) {

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "acceleration", type: "g", value: acceleration });
			bp.send(this.channel, BridgePackets.BP_SETACCELERATION, function () {
				this.data.acceleration = acceleration / this.data.rescaleFactor;
				if (typeof this.setAccelerationSuccess === "function")
					this.setAccelerationSuccess(acceleration);
			}.bind(this));
		};

		Stepper.prototype.getMinAcceleration = function() {

			return (this.data.minAcceleration * this.data.rescaleFactor);
		};

		Stepper.prototype.getMaxAcceleration = function() {

			return (this.data.maxAcceleration * this.data.rescaleFactor);
		};

		Stepper.prototype.getPosition = function() {

			return ((this.data.position + this.data.positionOffset) * this.data.rescaleFactor);
		};

		Stepper.prototype.getMinPosition = function() {

			return ((this.data.minPosition + this.data.positionOffset) * this.data.rescaleFactor);
		};

		Stepper.prototype.getMaxPosition = function() {

			return ((this.data.maxPosition + this.data.positionOffset) * this.data.rescaleFactor);
		};

		Stepper.prototype.setRescaleFactor = function(rescaleFactor) {

			this.data.rescaleFactor = rescaleFactor;
		};

		Stepper.prototype.getTargetPosition = function() {

			return ((this.data.targetPosition + this.data.positionOffset) * this.data.rescaleFactor);
		};

		Stepper.prototype.setTargetPosition = function(targetPosition) {
			var self = this;
			var calcPosition = (targetPosition / this.data.rescaleFactor) - this.data.positionOffset;

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "targetPosition", type: "l", value: calcPosition });
			return (bp.send(this.channel, BridgePackets.BP_SETTARGETPOSITION).then(function () {
				self.data.targetPosition = calcPosition;
				if (self.getEngaged() === true && self.getVelocityLimit() !== 0 && self.getPosition() !== self.getTargetPosition())
					self.data.isMoving = true;
			}));
		};

		Stepper.prototype.getVelocity = function() {

			return (this.data.velocity * this.data.rescaleFactor);
		};

		Stepper.prototype.getMaxVelocity = function() {

			return (this.data.maxVelocity * this.data.rescaleFactor);
		};

		Stepper.prototype.getVelocityLimit = function() {

			if (this.data.velocityLimit == 1e300)
				throw (new PhidgetError(ErrorCode.UNKNOWN_VALUE));
			else
				return (this.data.velocityLimit * this.data.rescaleFactor);
		};

		Stepper.prototype.setVelocityLimit = function(velocityLimit) {
			var self = this;
			var calcLimit = velocityLimit / this.data.rescaleFactor;

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "velocityLimit", type: "g", value: calcLimit });
			return (bp.send(this.channel, BridgePackets.BP_SETVELOCITYLIMIT).then(function () {
				self.data.velocityLimit = calcLimit;
				if (self.getEngaged() === true && self.getVelocityLimit() !== 0 && self.getPosition() !== self.getTargetPosition())
					self.data.isMoving = true;
			}));
		};

		Stepper.prototype.getMaxVelocityLimit = function() {

			return (this.data.maxVelocityLimit * this.data.rescaleFactor);
		};

		Stepper.prototype.getMinVelocityLimit = function () {

			return (this.data.minVelocityLimit * this.data.rescaleFactor);
		};

		Stepper.prototype.addPositionOffset = function (positionOffset) {

			this.data.positionOffset += (positionOffset / this.data.rescaleFactor);
		};

		Stepper.prototype.handleStoppedEvent = function (bp) {

			this.data.isMoving = false;
			this.onStopped();
		};

		Stepper.prototype.handlePositionChangeEvent = function (bp) {

			this.data.position = bp.get("0");

			this.onPositionChange((this.data.position + this.data.positionOffset) * this.data.rescaleFactor);
		};

		Stepper.prototype.handleVelocityChangeEvent = function (bp) {

			this.data.velocity = bp.get("0");

			this.onVelocityChange(this.data.velocity * this.data.rescaleFactor);
		};

		var TemperatureSensor = function TemperatureSensor() {
			Phidget.apply(this, arguments);
			this.name = "TemperatureSensor";
			this.class = ChannelClass.TEMPERATURE_SENSOR;

			this.onTemperatureChange = function (temperature) {};
			this.onError = function (code, desc) {};
		};
		TemperatureSensor.prototype = Object.create(Phidget.prototype);
		TemperatureSensor.prototype.constructor = TemperatureSensor;
		self.TemperatureSensor = TemperatureSensor;

		TemperatureSensor.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		TemperatureSensor.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		TemperatureSensor.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 0 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_TEMPERATURECHANGE:
				this.handleTemperatureChangeEvent(bp);
				break;
			}
			return (true);
		};

		TemperatureSensor.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETRTDTYPE:
				this.data.RTDType =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('RTDType');
				return (true);
			case BridgePackets.BP_SETRTDWIRESETUP:
				this.data.RTDWireSetup =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('RTDWireSetup');
				return (true);
			case BridgePackets.BP_SETCHANGETRIGGER:
				this.data.temperatureChangeTrigger =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('TemperatureChangeTrigger');
				return (true);
			case BridgePackets.BP_SETTHERMOCOUPLETYPE:
				this.data.thermocoupleType =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('ThermocoupleType');
				return (true);
			}
		}

		TemperatureSensor.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		TemperatureSensor.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		TemperatureSensor.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		TemperatureSensor.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		TemperatureSensor.prototype.getRTDType = function() {

			this.checkOpen();

			return (this.data.RTDType);
		};

		TemperatureSensor.prototype.setRTDType = function(RTDType) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: RTDType });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETRTDTYPE).then(function (res) {
				self.data.RTDType = RTDType;
			}));
		};

		TemperatureSensor.prototype.getRTDWireSetup = function() {

			this.checkOpen();

			return (this.data.RTDWireSetup);
		};

		TemperatureSensor.prototype.setRTDWireSetup = function(RTDWireSetup) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: RTDWireSetup });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETRTDWIRESETUP).then(function (res) {
				self.data.RTDWireSetup = RTDWireSetup;
			}));
		};

		TemperatureSensor.prototype.getTemperature = function() {

			this.checkOpen();

			return (this.data.temperature);
		};

		TemperatureSensor.prototype.getMinTemperature = function() {

			this.checkOpen();

			return (this.data.minTemperature);
		};

		TemperatureSensor.prototype.getMaxTemperature = function() {

			this.checkOpen();

			return (this.data.maxTemperature);
		};

		TemperatureSensor.prototype.getTemperatureChangeTrigger = function() {

			this.checkOpen();

			return (this.data.temperatureChangeTrigger);
		};

		TemperatureSensor.prototype.setTemperatureChangeTrigger = function(temperatureChangeTrigger) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: temperatureChangeTrigger });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCHANGETRIGGER).then(function (res) {
				self.data.temperatureChangeTrigger = temperatureChangeTrigger;
			}));
		};

		TemperatureSensor.prototype.getMinTemperatureChangeTrigger = function() {

			this.checkOpen();

			return (this.data.minTemperatureChangeTrigger);
		};

		TemperatureSensor.prototype.getMaxTemperatureChangeTrigger = function() {

			this.checkOpen();

			return (this.data.maxTemperatureChangeTrigger);
		};

		TemperatureSensor.prototype.getThermocoupleType = function() {

			this.checkOpen();

			return (this.data.thermocoupleType);
		};

		TemperatureSensor.prototype.setThermocoupleType = function(thermocoupleType) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: thermocoupleType });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETTHERMOCOUPLETYPE).then(function (res) {
				self.data.thermocoupleType = thermocoupleType;
			}));
		};

		TemperatureSensor.prototype.handleTemperatureChangeEvent = function (bp) {

			this.data.temperature = bp.get("0");

			this.onTemperatureChange(this.data.temperature);
		};


		var VoltageInput = function VoltageInput() {
			Phidget.apply(this, arguments);
			this.name = "VoltageInput";
			this.class = ChannelClass.VOLTAGE_INPUT;

			this.onVoltageChange = function (voltage) {};
			this.onSensorChange = function (sensorValue, sensorUnit) {};
			this.onError = function (code, desc) {};
		};
		VoltageInput.prototype = Object.create(Phidget.prototype);
		VoltageInput.prototype.constructor = VoltageInput;
		self.VoltageInput = VoltageInput;

		VoltageInput.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		VoltageInput.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		VoltageInput.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 0 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_SENSORCHANGE:
				this.handleSensorChangeEvent(bp);
				break;
			case BridgePackets.BP_VOLTAGECHANGE:
				this.handleVoltageChangeEvent(bp);
				break;
			}
			return (true);
		};

		VoltageInput.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETPOWERSUPPLY:
				this.data.powerSupply =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('PowerSupply');
				return (true);
			case BridgePackets.BP_SETSENSORTYPE:
				this.data.sensorType =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('SensorType');
				return (true);
			case BridgePackets.BP_SETSENSORVALUECHANGETRIGGER:
				this.data.sensorValueChangeTrigger =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('SensorValueChangeTrigger');
				return (true);
			case BridgePackets.BP_SETCHANGETRIGGER:
				this.data.voltageChangeTrigger =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('VoltageChangeTrigger');
				return (true);
			case BridgePackets.BP_SETVOLTAGERANGE:
				this.data.voltageRange =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('VoltageRange');
				return (true);
			}
		}

		VoltageInput.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		VoltageInput.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		VoltageInput.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		VoltageInput.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		VoltageInput.prototype.getPowerSupply = function() {

			this.checkOpen();

			return (this.data.powerSupply);
		};

		VoltageInput.prototype.setPowerSupply = function(powerSupply) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: powerSupply });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETPOWERSUPPLY).then(function (res) {
				self.data.powerSupply = powerSupply;
			}));
		};

		VoltageInput.prototype.getSensorType = function() {

			this.checkOpen();

			return (this.data.sensorType);
		};

		VoltageInput.prototype.setSensorType = function(sensorType) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: sensorType });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETSENSORTYPE).then(function (res) {
				self.data.sensorType = sensorType;
			}));
		};

		VoltageInput.prototype.getSensorUnit = function() {

			this.checkOpen();

			return (this.data.sensorUnit);
		};

		VoltageInput.prototype.getSensorValue = function() {

			this.checkOpen();

			return (this.data.sensorValue);
		};

		VoltageInput.prototype.getSensorValueChangeTrigger = function() {

			this.checkOpen();

			return (this.data.sensorValueChangeTrigger);
		};

		VoltageInput.prototype.setSensorValueChangeTrigger = function(sensorValueChangeTrigger) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: sensorValueChangeTrigger });
			var self = this;
			return (bp.send(this.channel,
			  BridgePackets.BP_SETSENSORVALUECHANGETRIGGER).then(function (res) {
				self.data.sensorValueChangeTrigger = sensorValueChangeTrigger;
			}));
		};

		VoltageInput.prototype.getVoltage = function() {

			this.checkOpen();

			return (this.data.voltage);
		};

		VoltageInput.prototype.getMinVoltage = function() {

			this.checkOpen();

			return (this.data.minVoltage);
		};

		VoltageInput.prototype.getMaxVoltage = function() {

			this.checkOpen();

			return (this.data.maxVoltage);
		};

		VoltageInput.prototype.getVoltageChangeTrigger = function() {

			this.checkOpen();

			return (this.data.voltageChangeTrigger);
		};

		VoltageInput.prototype.setVoltageChangeTrigger = function(voltageChangeTrigger) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: voltageChangeTrigger });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCHANGETRIGGER).then(function (res) {
				self.data.voltageChangeTrigger = voltageChangeTrigger;
			}));
		};

		VoltageInput.prototype.getMinVoltageChangeTrigger = function() {

			this.checkOpen();

			return (this.data.minVoltageChangeTrigger);
		};

		VoltageInput.prototype.getMaxVoltageChangeTrigger = function() {

			this.checkOpen();

			return (this.data.maxVoltageChangeTrigger);
		};

		VoltageInput.prototype.getVoltageRange = function() {

			this.checkOpen();

			return (this.data.voltageRange);
		};

		VoltageInput.prototype.setVoltageRange = function(voltageRange) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: voltageRange });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETVOLTAGERANGE).then(function (res) {
				self.data.voltageRange = voltageRange;
			}));
		};

		VoltageInput.prototype.handleSensorChangeEvent = function (bp) {

			this.data.sensorValue = bp.get("0");
			var sensorUnit = {
				unit: bp.get("UnitInfo.unit"),
				name: bp.get("UnitInfo.name"),
				symbol: bp.get("UnitInfo.symbol"),
			};
			this.data.sensorUnit = sensorUnit;

			this.onSensorChange(this.data.sensorValue, this.data.sensorUnit);
		};

		VoltageInput.prototype.handleVoltageChangeEvent = function (bp) {

			this.data.voltage = bp.get("0");

			this.onVoltageChange(this.data.voltage);
		};


		var VoltageOutput = function VoltageOutput() {
			Phidget.apply(this, arguments);
			this.name = "VoltageOutput";
			this.class = ChannelClass.VOLTAGE_OUTPUT;

			this.onError = function (code, desc) {};
		};
		VoltageOutput.prototype = Object.create(Phidget.prototype);
		VoltageOutput.prototype.constructor = VoltageOutput;
		self.VoltageOutput = VoltageOutput;

		VoltageOutput.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		VoltageOutput.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		VoltageOutput.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 0 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			}
			return (true);
		};

		VoltageOutput.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETENABLED:
				this.data.enabled =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Enabled');
				return (true);
			case BridgePackets.BP_SETVOLTAGE:
				this.data.voltage =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('Voltage');
				return (true);
			case BridgePackets.BP_SETVOLTAGERANGE:
				this.data.voltageOutputRange =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('VoltageOutputRange');
				return (true);
			}
		}

		VoltageOutput.prototype.setEnabled = function(enabled) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: enabled });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETENABLED).then(function (res) {
				self.data.enabled = enabled;
			}));
		};

		VoltageOutput.prototype.getEnabled = function() {

			this.checkOpen();

			return (!!this.data.enabled);
		};

		VoltageOutput.prototype.getVoltage = function() {

			this.checkOpen();

			return (this.data.voltage);
		};

		VoltageOutput.prototype.setVoltage = function(voltage) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: voltage });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETVOLTAGE).then(function (res) {
				self.data.voltage = voltage;
			}));
		};

		VoltageOutput.prototype.getMinVoltage = function() {

			this.checkOpen();

			return (this.data.minVoltage);
		};

		VoltageOutput.prototype.getMaxVoltage = function() {

			this.checkOpen();

			return (this.data.maxVoltage);
		};

		VoltageOutput.prototype.getVoltageOutputRange = function() {

			this.checkOpen();

			return (this.data.voltageOutputRange);
		};

		VoltageOutput.prototype.setVoltageOutputRange = function(voltageOutputRange) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: voltageOutputRange });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETVOLTAGERANGE).then(function (res) {
				self.data.voltageOutputRange = voltageOutputRange;
			}));
		};

		VoltageOutput.prototype.setVoltageOutputRangeSuccess = function (voltageOutputRange) {

			switch (parseInt(voltageOutputRange)) {
				case VoltageOutputRange.VOLTS_10:
					this.data.minVoltage = -10;
					this.data.maxVoltage = 10;
					break;
				case VoltageOutputRange.VOLTS_5:
					this.data.minVoltage = 0;
					this.data.maxVoltage = 5;
					break;
			}
		};

		var VoltageRatioInput = function VoltageRatioInput() {
			Phidget.apply(this, arguments);
			this.name = "VoltageRatioInput";
			this.class = ChannelClass.VOLTAGE_RATIO_INPUT;

			this.onVoltageRatioChange = function (voltageRatio) {};
			this.onSensorChange = function (sensorValue, sensorUnit) {};
			this.onError = function (code, desc) {};
		};
		VoltageRatioInput.prototype = Object.create(Phidget.prototype);
		VoltageRatioInput.prototype.constructor = VoltageRatioInput;
		self.VoltageRatioInput = VoltageRatioInput;

		VoltageRatioInput.prototype.handleErrorEvent = function (bp) {

			this.onError(bp.entries[0].v, bp.entries[1].v);
		};

		VoltageRatioInput.prototype.bridgeInput = function (bp) {
			var res;

			if (this.handleUnsupportedBridgePacket) {
				res = this.handleUnsupportedBridgePacket(bp);
				if (res === true)
					return;
			}

			res = this._event(bp);
			if (res === true)
				return;

			res = this._bridgeInput(bp);
			if (res === true)
				return;

			throw (new PhidgetError(ErrorCode.INVALID_PACKET,
			  "unsupported bridge packet: 0x" + bp.vpkt.toString(16)));
		}

		VoltageRatioInput.prototype._event = function (bp) {

			switch (bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETSTATUS:
				this.handleSetStatus(bp, 0 /* version */);
				break;
			case BridgePackets.BP_ERROREVENT:
				this.handleErrorEvent(bp);
				break;
			case BridgePackets.BP_SENSORCHANGE:
				this.handleSensorChangeEvent(bp);
				break;
			case BridgePackets.BP_VOLTAGERATIOCHANGE:
				this.handleVoltageRatioChangeEvent(bp);
				break;
			}
			return (true);
		};

		VoltageRatioInput.prototype._bridgeInput = function(bp) {

			switch(bp.vpkt) {
			default:
				return (false);
			case BridgePackets.BP_SETENABLED:
				this.data.bridgeEnabled =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('BridgeEnabled');
				return (true);
			case BridgePackets.BP_SETBRIDGEGAIN:
				this.data.bridgeGain =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('BridgeGain');
				return (true);
			case BridgePackets.BP_SETDATAINTERVAL:
				this.data.dataInterval =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('DataInterval');
				return (true);
			case BridgePackets.BP_SETSENSORTYPE:
				this.data.sensorType =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('SensorType');
				return (true);
			case BridgePackets.BP_SETSENSORVALUECHANGETRIGGER:
				this.data.sensorValueChangeTrigger =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('SensorValueChangeTrigger');
				return (true);
			case BridgePackets.BP_SETCHANGETRIGGER:
				this.data.voltageRatioChangeTrigger =  + bp.entries[0].v;
				if (this.onPropertyChange)
					this.onPropertyChange('VoltageRatioChangeTrigger');
				return (true);
			}
		}

		VoltageRatioInput.prototype.getBridgeEnabled = function() {

			this.checkOpen();

			return (!!this.data.bridgeEnabled);
		};

		VoltageRatioInput.prototype.setBridgeEnabled = function(bridgeEnabled) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: bridgeEnabled });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETENABLED).then(function (res) {
				self.data.bridgeEnabled = bridgeEnabled;
			}));
		};

		VoltageRatioInput.prototype.getBridgeGain = function() {

			this.checkOpen();

			return (this.data.bridgeGain);
		};

		VoltageRatioInput.prototype.setBridgeGain = function(bridgeGain) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: bridgeGain });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETBRIDGEGAIN).then(function (res) {
				self.data.bridgeGain = bridgeGain;
			}));
		};

		VoltageRatioInput.prototype.getDataInterval = function() {

			this.checkOpen();

			return (this.data.dataInterval);
		};

		VoltageRatioInput.prototype.setDataInterval = function(dataInterval) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "u", value: dataInterval });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETDATAINTERVAL).then(function (res) {
				self.data.dataInterval = dataInterval;
			}));
		};

		VoltageRatioInput.prototype.getMinDataInterval = function() {

			this.checkOpen();

			return (this.data.minDataInterval);
		};

		VoltageRatioInput.prototype.getMaxDataInterval = function() {

			this.checkOpen();

			return (this.data.maxDataInterval);
		};

		VoltageRatioInput.prototype.getSensorType = function() {

			this.checkOpen();

			return (this.data.sensorType);
		};

		VoltageRatioInput.prototype.setSensorType = function(sensorType) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "d", value: sensorType });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETSENSORTYPE).then(function (res) {
				self.data.sensorType = sensorType;
			}));
		};

		VoltageRatioInput.prototype.getSensorUnit = function() {

			this.checkOpen();

			return (this.data.sensorUnit);
		};

		VoltageRatioInput.prototype.getSensorValue = function() {

			this.checkOpen();

			return (this.data.sensorValue);
		};

		VoltageRatioInput.prototype.getSensorValueChangeTrigger = function() {

			this.checkOpen();

			return (this.data.sensorValueChangeTrigger);
		};

		VoltageRatioInput.prototype.setSensorValueChangeTrigger = function(sensorValueChangeTrigger) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: sensorValueChangeTrigger });
			var self = this;
			return (bp.send(this.channel,
			  BridgePackets.BP_SETSENSORVALUECHANGETRIGGER).then(function (res) {
				self.data.sensorValueChangeTrigger = sensorValueChangeTrigger;
			}));
		};

		VoltageRatioInput.prototype.getVoltageRatio = function() {

			this.checkOpen();

			return (this.data.voltageRatio);
		};

		VoltageRatioInput.prototype.getMinVoltageRatio = function() {

			this.checkOpen();

			return (this.data.minVoltageRatio);
		};

		VoltageRatioInput.prototype.getMaxVoltageRatio = function() {

			this.checkOpen();

			return (this.data.maxVoltageRatio);
		};

		VoltageRatioInput.prototype.getVoltageRatioChangeTrigger = function() {

			this.checkOpen();

			return (this.data.voltageRatioChangeTrigger);
		};

		VoltageRatioInput.prototype.setVoltageRatioChangeTrigger = function(voltageRatioChangeTrigger) {

			if (this.isopen !== true)
				return (jPhidget_reject(ErrorCode.NOT_ATTACHED));

			var bp = new BridgePacket(this.channel.conn);
			bp.set({ name: "0", type: "g", value: voltageRatioChangeTrigger });
			var self = this;
			return (bp.send(this.channel, BridgePackets.BP_SETCHANGETRIGGER).then(function (res) {
				self.data.voltageRatioChangeTrigger = voltageRatioChangeTrigger;
			}));
		};

		VoltageRatioInput.prototype.getMinVoltageRatioChangeTrigger = function() {

			this.checkOpen();

			return (this.data.minVoltageRatioChangeTrigger);
		};

		VoltageRatioInput.prototype.getMaxVoltageRatioChangeTrigger = function() {

			this.checkOpen();

			return (this.data.maxVoltageRatioChangeTrigger);
		};

		VoltageRatioInput.prototype.handleSensorChangeEvent = function (bp) {

			this.data.sensorValue = bp.get("0");
			var sensorUnit = {
				unit: bp.get("UnitInfo.unit"),
				name: bp.get("UnitInfo.name"),
				symbol: bp.get("UnitInfo.symbol"),
			};
			this.data.sensorUnit = sensorUnit;

			this.onSensorChange(this.data.sensorValue, this.data.sensorUnit);
		};

		VoltageRatioInput.prototype.handleVoltageRatioChangeEvent = function (bp) {

			this.data.voltageRatio = bp.get("0");

			this.onVoltageRatioChange(this.data.voltageRatio);
		};

		VoltageRatioInput.prototype.handleUnsupportedBridgePacket = function (bp) {
			switch (bp.vpkt) {
			case BridgePackets.BP_DATAINTERVALCHANGE:
				this.data.dataInterval = bp.get("0");
				break;
			case BridgePackets.BP_MINDATAINTERVALCHANGE:
				this.data.minDataInterval = bp.get("0");
				break;
			default:
				return (false);
			}
			return (true);
		}


		/* End of phidget22 */
		return (self);
	}

	if (isNode) {
		module.exports = new phidget22();
	} else {
		window.phidget22 = new phidget22();
	}
}).call(this);