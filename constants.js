
// pubsub topics
exports.roverconnection_command = "rcc" // send connect/disconnect commands from web page via sockets to phidget controller
exports.roverconnection_status = "rcs"  // send phidget connection status back to sockets controller to send to web page
exports.rovervelocity_command = "rvc"   // send velocity commands from web page via sockets to phidget controller
exports.roversteering_command = "rss"   // send steering command from web page via sockets to phidgets controller
exports.rovervelocity_statusrequest = "rvsreq"    // request motor velocity
exports.rovervelocity_statusreport = "rvrpt"    // report motor velocity
exports.errorreport = "errorrpt"    // report an error from the phidget controller to send to web page

// motor definitions
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
