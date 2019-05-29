/***********************************************************************
 * PhidgetsServer Class
 * by David Hodges, Outermost Software, LLC, 2019
 * NodeJs controller to communicate with Phidgets rover
 * Usage in calling script (app.js):
 * phidget.phidgetServer();
 * It communicates with app.js asynchronously using the pubsub.js methods
 *
 ***********************************************************************/
const phidget22 = require('phidget22');
const pubsub = require('pubsub-js');
const global = require('./constants');
const math = require('mathjs'); // for accurate math in the steering function
const diffSteer = require('diff-steer'); // differential steering algorithm

const ch1 = new phidget22.DCMotor();// right front motor controller
const tp1 = new phidget22.TemperatureSensor(); // right front temperature sensor
const ch2 = new phidget22.DCMotor();// right rear motor controller
const tp2 = new phidget22.TemperatureSensor(); // right rear temperature sensor
const ch3 = new phidget22.DCMotor();// left front motor controller
const tp3 = new phidget22.TemperatureSensor(); // left front temperature sensor
const ch4 = new phidget22.DCMotor();// left rear motor controller
const tp4 = new phidget22.TemperatureSensor(); // left rear temperature sensor
const dist1 = new phidget22.DistanceSensor();
const dist2 = new phidget22.DistanceSensor();

var velocity = 0.00; // current velocity before steering adjustments

//
// phidgetServer is the main class to handle events from the phidgets server and from the node server
exports.phidgetServer = function () {

   var conn = new phidget22.Connection(global.PhidgetsSBCServerPort, global.PhidgetSBCServer);
  // var conn = new phidget22.Connection(5661, '192.168.99.1');
    //
    // respond to connection commands
    //
    pubsub.subscribe(global.roverconnection_command, function (msg, data) {
        console.log(data)
        if (data == "connect") {
            conn.connect().then(function () {
                console.log('Phidget Server Connected');
                pubsub.publish(global.roverconnection_status, "connected");
                startMotors();
                velocity = 0.00;
                startDistanceSensors();

            }).catch(function (err) {
                console.log('failed to connect to server:' + err);
            });
        }
        else if (data == "disconnect") {
            conn.close();
            velocity = 0.00;
            console.log('Phidget Server Disconnected');
            pubsub.publish(global.roverconnection_status, "disconnected");
        }
    });
    conn.onDisconnect(function () {
        pubsub.publish(global.roverconnection_status, "disconnected");
    });
    //

    pubsub.subscribe(global.rovervelocity_command, function (msg, data) {
        if (conn.connected && ch1.getAttached() && ch2.getAttached() && ch3.getAttached() && ch4.getAttached()) {
            var newvelocity = math.round(math.divide(data, 100), 2);// save current velocity in global variable for steering reference point
            if (newvelocity != velocity) {
                velocity = newvelocity;
                ch1.setTargetVelocity(velocity);
                ch2.setTargetVelocity(velocity);
                ch3.setTargetVelocity(velocity);
                ch4.setTargetVelocity(velocity);
                console.log('Velocity change received, new Velocity is ' + velocity);
            }
        }
    });
    pubsub.subscribe(global.roversteering_command, function (msg, data) {

        var newVector = math.number(data);
        if (newVector != 0) {
            newVector = math.round(math.divide(newVector, 50), 2);
        }
        if (conn.connected && ch1.getAttached() && ch2.getAttached() && ch3.getAttached() && ch4.getAttached()) {
            // ch1 and ch2 are the right wheels
            // ch3 and ch4 are the left wheels
            var leftNewVelocity = 0.00;
            var rightNewVelocity = 0.00;

            if (newVector == 0) {
                // go straight at last registered velocity

                ch1.setTargetVelocity(velocity);
                ch2.setTargetVelocity(velocity);
                ch3.setTargetVelocity(velocity);
                ch4.setTargetVelocity(velocity);
                console.log("NewVector is 0, returning");
                return;
            }
            else if (newVector < 0) {
                // turn left
                if (velocity >= 0) {
                    newVector = math.abs(newVector);
                }
                console.log('left turn, vector is ' + newVector);
                rightNewVelocity = math.round(math.add(velocity, newVector), 2);
                rightNewVelocity = rightNewVelocity > 1 ? 1 : rightNewVelocity;
                leftNewVelocity = 0;
                console.log('Turning left, global velocity is ' + velocity);
                console.log('Turning left, new right velocity is ' + rightNewVelocity);
            }
            else {
                // turn right
                if (velocity < 0) {
                    newVector = - newVector;
                }
                console.log('right turn, vector is ' + newVector);
                rightNewVelocity = 0;
                leftNewVelocity = math.round(math.add(velocity, newVector), 2);
                leftNewVelocity = leftNewVelocity > 1 ? 1 : leftNewVelocity;
                console.log('Turning right, global velocity is ' + velocity);
                console.log('Turning right, new left velocity is ' + leftNewVelocity);
            }
            console.log('left velocity: ' + leftNewVelocity)
            console.log('right velocity: ' + rightNewVelocity)

            ch1.setTargetVelocity(rightNewVelocity);
            ch2.setTargetVelocity(rightNewVelocity);
            ch3.setTargetVelocity(leftNewVelocity);
            ch4.setTargetVelocity(leftNewVelocity);
        }
    });

    pubsub.subscribe(global.roverthumbstick_command, function (msg, data) {
        var TSTransport = data;
        var x = TSTransport.X;
        var y = TSTransport.Y;
        //console.log(TSTransport);
        // experiment with diffsteer package
        // diffsteer assumes both velocity and steering (X and Y) will be in the range of -1 to 1.
        diffSteer.flipAxis = -1; // Defaults to -1
        var testSteer = diffSteer( x, y)
        var conversionFactor = 1.000/255;
        var leftNewVelocity = testSteer[0]*conversionFactor;
        var rightNewVelocity = testSteer[1]*conversionFactor;
        console.log(testSteer);
        console.log(`New velocities after diffSteer. Left: ${leftNewVelocity}. Right: ${rightNewVelocity}.`)
        ch1.setTargetVelocity(rightNewVelocity);
        ch2.setTargetVelocity(rightNewVelocity);
        ch3.setTargetVelocity(leftNewVelocity);
        ch4.setTargetVelocity(leftNewVelocity);
    });
        //
    // Respond to commands to the motors
    //

    var startMotor = function(_ch, hubSerialNumber, hubPort)
    {
        _ch.isRemote = true;
        _ch.setDeviceSerialNumber(hubSerialNumber);
        _ch.setChannel(0);
        _ch.setHubPort(hubPort);
        _ch.onAttach = function () {
           // console.log(`Motor ${hubPort} attached`);
        }
        _ch.onDetach = function () {
           // console.log(`Motor ${hubPort} detached`);
        }
        _ch.onVelocityUpdate = function( velocity) {

            var t = new global.objTelemetry("velocity", velocity,"DCMotor", _ch.getHubPort());
            pubsub.publish(global.telemetry, t);
        }
        // Handle error on all channels by shutting down the motors
        _ch.onError = function (errorCode, errorDescription){
            console.log(`Error detected: ${errorDescription}`);
            stopAllMotors();
            pubsub.publish(global.errorreport, `Error: ${errorCode}: ${errorDescription}`);

        }
        _ch.open().then(function (_ch) {
           // console.log(`channel ${_ch.getHubPort()} open`);

        }).catch(function (err) {
           // console.log(`failed to open the channel: ${err}`);
        });
    }
    var startTemperatureSensor = function(_ch, hubSerialNumber, hubPort)
    {
        _ch.isRemote = true;
        _ch.setDeviceSerialNumber(hubSerialNumber);
        _ch.setChannel(0);
        _ch.setHubPort(hubPort);

        _ch.onAttach = function (ch) {
           // console.log(ch + ' attached');
          //  console.log('min temperature:' + ch.getMinTemperature());
          //  console.log('max temperature:' + ch.getMaxTemperature());
        };

        _ch.onDetach = function (ch) {
           // console.log(ch + ' detached');
        };

        _ch.onTemperatureChange = function (temp) {
           // console.log('temperature:' + temp + ' (' + this.getTemperature() + ')');
            var t = new global.objTelemetry("temperature", this.getTemperature(),"temperatureSensor", _ch.getHubPort());
            pubsub.publish(global.telemetry, t);
        };

        _ch.open().then(function (ch) {
           // console.log('temperature channel open');
        }).catch(function (err) {
          //  console.log('failed to open the channel:' + err);
        });

    }
    var startDistanceSensor = function(_ch, hubSerialNumber, hubPort)
    {
        _ch.isRemote = true;
        _ch.setDeviceSerialNumber(hubSerialNumber);
        _ch.setChannel(0);
        _ch.setHubPort(hubPort);
        _ch.onAttach = function (ch) {
           // console.log(ch + ' attached');
           // console.log('Min Distance:' + ch.getMinDistance());
           // console.log('Max Distance:' + ch.getMaxDistance());
        };

        _ch.onDetach = function (ch) {
           // console.log(ch + ' detached');
        };

        _ch.onDistanceChange = function (distance) {
            var sensorLocation = "front";
            var thisHubPort= _ch.getHubPort();
            if (_ch.getHubPort() != distanceFront.hubPort)
            {
                sensorLocation = "back";
            }
            var t = new global.objTelemetry("distance", this.getDistance(),"distanceSensor", sensorLocation);
            pubsub.publish(global.telemetry, t);
        };

        _ch.onSonarReflectionsUpdate = function (distances, amplitudes, count) {
            //console.log('Distance | Amplitude');
           // for (var i = 0; i < count; i++)
               // console.log(distances[i] + '\t | ' + amplitudes[i]);
        };

        _ch.open().then(function (ch) {
           // console.log('Distance Sensor channel open');
        }).catch(function (err) {
           // console.log('failed to open the Distance Sensor channel:' + err);
        });
    }
    var startMotors = function () {
        //start right side motors
        startMotor(ch1, motorRightFront.hubSerialNumber, motorRightFront.hubPort)
        startTemperatureSensor(tp1,motorRightFront.hubSerialNumber, motorRightFront.hubPort)
        startMotor(ch2, motorRightRear.hubSerialNumber, motorRightRear.hubPort)
        startTemperatureSensor(tp2, motorRightRear.hubSerialNumber, motorRightRear.hubPort)
        // start left side motors
        startMotor(ch3, motorLeftFront.hubSerialNumber, motorLeftFront.hubPort);
        startTemperatureSensor(tp3,motorLeftFront.hubSerialNumber, motorLeftFront.hubPort);
        startMotor(ch4, motorLeftRear.hubSerialNumber, motorLeftRear.hubPort);
        startTemperatureSensor(tp4,motorLeftRear.hubSerialNumber, motorLeftRear.hubPort);
    }
    var startDistanceSensors = function () {
        // start distance sensors
        startDistanceSensor(dist1, distanceFront.hubSerialNumber, distanceFront.hubPort)
        startDistanceSensor(dist2, distanceRear.hubSerialNumber, distanceRear.hubPort)

    }
    var stopAllMotors = function () {
        velocity = 0;
        ch1.setTargetVelocity(velocity);
        ch2.setTargetVelocity(velocity);
        ch3.setTargetVelocity(velocity);
        ch4.setTargetVelocity(velocity);
        console.log("All motors stopped");
    }
}
