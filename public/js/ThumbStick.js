/***********************************************************************
 * ThumbStick Class
 * by David Hodges, Outermost Software, LLC, 2019
 * Javascript controller for Phidget Thumbstick
 * Usage in calling script:
 * window.thumbStick = new ThumbStick();
 *  thumbStick.ThumbConnect();
 * Then the calling script can subsribe to events coming from the ThumbStick as follows:
 * PubSub.subscribe("thumbstick", mySubscriberFunction)
 * PubSub.subscribe("thumbstick-digitalInput", mySubscriberFunction)
 * requires the following declarations on main page:
 * <script type="text/javascript" src="js/jquery-3.3.1.min.js"></script>
 *  <script src="js/sha256.min.js"></script>
 * <script src="js/phidget22.min.js"></script>
 * <script src="js/pubsub.js"></script>
 ***********************************************************************/
class ThumbStick {
  constructor(x) {
    this.x = x;
    var self = this;
    this.conn = new phidget22.Connection(8989, "localhost");
    this.ch0 = new phidget22.VoltageRatioInput(); // axis 0
    this.ch1 = new phidget22.VoltageRatioInput(); // axis 1
    this.chDigital = new phidget22.DigitalInput();
    //ThumbStick Transport Object to send X and Y axis values to server
    this.tsTransport = {};
    // when the thumbstick is at rest it doesn't go to full 0,0, so we adjust it manually
    this.thresholdX = .1; // t
    this.thresholdY = .1; //
    this.ThumbConnect = function() {
      // Axis 0 on the Thumbstick (y-axis)
      var ch0 = self.ch0;
      ch0.setIsHubPortDevice(false);
      ch0.setHubPort(0);
      ch0.setChannel(0);
      ch0.onError = onError;
      ch0.onAttach = onAttach;
      // Axis 1 on the Thumbstick (x-axis)
      var ch1 = self.ch1;
      ch1.setIsHubPortDevice(false);
      ch1.setHubPort(0);
      ch1.setChannel(1);
      ch1.onError = onError;
      ch1.onAttach = onAttach;
      // the push button on the Thumbstick
      var chDigital = self.chDigital;
      chDigital.setIsHubPortDevice(false);
      chDigital.setHubPort(0);
      chDigital.setChannel(0);
      chDigital.onError = onError;
      chDigital.onAttach = onAttach;
      self.conn.onError = onConnectionError;
      // axes (ie thumbsticks)
      self.tsTransport.Y = 0.0;  // velocity
      self.tsTransport.X = 0.0;  // steering
      self.conn
        .connect()
        .then(function() {
          console.log("local Phidget Server Connected (for thumbstick)");
          $("#lblThumbStickStatus").text(`Thumbstick is connected.`);

          PubSub.publish("thumbstick", "Connected");
          ch0.open(5000).then(function(ch0) {
            ch0.onVoltageRatioChange = ratioChangeAxis0;
            console.log("channel open");
          })
          .catch(function(err) {
            console.log("failed to open the x channel:" + err);
          });
          ch1.open(5000).then(function(ch1) {
            console.log("channel open");
            ch1.onVoltageRatioChange = ratioChangeAxis1;
          })
          .catch(function(err) {
            console.log("failed to open the y channel:" + err);
          });
          chDigital.open().then(function(chDigital) {
            console.log("digital Input open");
            chDigital.onStateChange = stateChangeDigitalInput;
            console.log("channel open");
            PubSub.publish("thumbstick-digitalInput", "x-axis open");
          })
          .catch(function(err) {
            console.log("failed to open the digital channel:" + err);
          });
        })
        .catch(function(err) {
          console.log("failed to connect to server:" + err);
        });
    };
    var onError = function(arg0, arg1) {
      console.log(`Channel error:${arg0}: ${arg1}`);
    };
    var onConnectionError = function(arg0, arg1) {
      console.log(`Connection error: ${arg0}: ${arg1}`);
      $("#lblThumbStickStatus").text(`Thumbstick Connection error: ${arg0}: ${arg1}`);
    };
    var onAttach = function(ch) {
      console.log("axis attached");
    };
    var ratioChangeAxis0 = function(ratio) {
      // console.log(`Axis 0: ${ratio}`);
      ratio = (ratio > -self.thresholdY && ratio < self.thresholdY) ? 0 : ratio;
      self.tsTransport.Y = ratio;
      PubSub.publish("thumbstick", self.tsTransport);
    };
    var ratioChangeAxis1 = function(ratio) {
      // console.log(`Axis 1: ${ratio}`);
      ratio = (ratio > -self.thresholdX && ratio < self.thresholdX)? 0 : ratio;
      self.tsTransport.X = ratio;
      PubSub.publish("thumbstick", self.tsTransport);
    };
    var stateChangeDigitalInput = function(state) {
      if (state) {
        PubSub.publish("thumbstick-digitalInput", true);
      } else {
        PubSub.publish("thumbstick-digitalInput", false);
      }
    };
  }
}
