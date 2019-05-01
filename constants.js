/***********************************************************************
 * constants.js
 * by David Hodges, Outermost Software, LLC, 2019
 * various addresses, constants, and classes common to both app.js and phidgetServer.js
 ***********************************************************************/
//
// network addresses (for reference)
//
WebCamAddress= "http://phidgetsbc.local:81/?action=stream";
PhidgetSBCServer = "http://phidgetsbc.local:5661";
LocalWebAdminPage = "http://localhost:3001";

// pubsub topics
exports.roverconnection_command = "rcc" // send connect/disconnect commands from web page via sockets to phidget controller
exports.roverconnection_status = "rcs"  // send phidget connection status back to sockets controller to send to web page
exports.rovervelocity_command = "rvc"   // send velocity commands from web page via sockets to phidget controller
exports.roversteering_command = "rss"   // send steering command from web page via sockets to phidgets controller
exports.errorreport = "errorrpt"    // report an error from the phidget controller to send to web page
exports.telemetry = "telemetry"  // for sensor and controller value reporting. Telemetry data is sent to the web page using "volatile", meaming they can be droped if the client is too busy

// motor definitions (DCMotor controllers)
motor0 = {
    hubSerialNumber: 515870,
    hubPort: 0
}
motor1 = {
    hubSerialNumber: 515870,
    hubPort: 1
}
motor2 = {
    hubSerialNumber: 515870,
    hubPort: 2
}
motor3 = {
    hubSerialNumber: 515870,
    hubPort: 3
}
motorLeftFront = Object.create(motor0)
motorLeftRear = Object.create(motor2);
motorRightFront = Object.create(motor1);
motorRightRear = Object.create(motor3);

// distance sensors
dist0 = {
    hubSerialNumber: 515870,
    hubPort: 4
}
dist1 = {
    hubSerialNumber: 515870,
    hubPort: 5
}
distanceFront = Object.create(dist0);
distanceRear = Object.create(dist1);
// telemetry object. This is for passing data back to the web page in a stream
class objTelemetry  {
    constructor(event, value, sourceName, sourceIndex){
    this.event = event;
    this.value = value;
    this.sourceName = sourceName; // can be "DCMotor", "distanceSensor", "temperatureSensor"
    this.sourceIndex = sourceIndex;// which controller or sensor sent the data value change
    }
}
module.exports.objTelemetry = objTelemetry;
