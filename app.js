/***********************************************************************
 * App.js
 * by David Hodges, Outermost Software, LLC, 2019
 * This is the main function of the NodeJS server program for the Phidgets Rover
 * It serves up the user's web page (public/index.html) with it's built in web server
 * It communicates with the user's web page and thumbstick using the sockets.io protocol
 * It communicates with the Rover interface in phidgetServer.js asynchronously using the pubsub.js protocol
 ***********************************************************************/
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const logger = require('morgan');

const indexRouter = require('./routes/index');
const usersRouter = require('./routes/users');

const app = express();
const pubsub = require('pubsub-js');
const global = require('./constants');
const phidget = require('./phidgetServer');
const math = require('mathjs'); // for accurate math
var debug = require('debug')('stalker:server');
const url = require('url');


const fs = require('fs');
const port = 3001
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '/public/')));

app.use('/', indexRouter);
app.use('/users', usersRouter);

module.exports = app;
var http = require('http');


app.set('port', port);

/**
 * Create HTTP server.
 */

var server = http.createServer(app);
/**
 * Listen on provided port, on all network interfaces.
 */

server.listen(port);
server.on('error', onError);
server.on('listening', function () {
  console.log('Listening to http://localhost:', port);
});
// handlers for socket server for 2 way communication with web page
const socketServer = function () {
    //
    // socket server events
    //
    io.on('connection', function (socket) {
      console.log('user connected');
      socket.on('connectRover', function (data) {
        if (data == 'true') {
          console.log("connection request received");
          pubsub.publish(global.roverconnection_command, "connect");


        }
        else {
          console.log("disconnect request received");
          pubsub.publish(global.rovervelocity_command, "0");
          pubsub.publish(global.roverconnection_command, "disconnect");

        }
      });
      socket.on('velocity', function (data) {
        // this event comes from the slider on the web page. Values are from -100 to 100, with steps in value of 1. .
        // 0 is stopped. Negative numbers mean reverse direction. Positive numbers mean forwards direction.
        var v = math.round(data, 2);
        pubsub.publish(global.rovervelocity_command, v);
      });
      socket.on('steering', function (data) {
        // this event comes from the slider on the web page. Values are from -10.0 to 10.0, with steps of .1
        var v = math.round(data, 2);
        pubsub.publish(global.roversteering_command, v);
      });
      socket.on('ThumbStick', function (data) {
          var TSTransport = JSON.parse(data);
          //console.log(`Got a ThumbStick socket request. X: ${TSTransport.X} Y: ${TSTransport.Y}`);
         pubsub.publish(global.roverthumbstick_command, TSTransport);
      });
      pubsub.subscribe(global.roverconnection_status, function (msg, data) {
        if (data == "connected") {
          socket.emit('connectionStatus', 'Rover is connected');
        }
        else if (data == "disconnected") {
          socket.emit('connectionStatus', 'Rover is not connected');
        }
      });
      pubsub.subscribe(global.errorreport, function (msg, data) {
        var responseArray = data;
        var jsonResponse = JSON.stringify(responseArray);
        socket.emit('errorReport', jsonResponse);
      });
      pubsub.subscribe(global.telemetry, function (msg, data) {
        var jsonTelemetry = JSON.stringify(data);
        socket.volatile.emit('telemetry', jsonTelemetry);
      });
    });

    var compareThumbStickValues = function(X, Y)
    {
      if (TSTransportSave.X == X && TSTransportSave.Y == Y)
      {
        return true;
      }
      return false;
    }
  } // end of socket handlers
  const setConnectionStatus = function (status) {
    if (status == "on") {
      io.on('connection', function (socket) {
        {
          socket.emit('connectionStatus', 'Rover is connected');
        }
      });
    }
  }



  //
  // start up socket server for communication with web page
  //
  var io = require('socket.io').listen(server);
  socketServer();
  // for test:
  //setConnectionStatus("on");
  //
  // startup phidget interface for communication with rover
  //
  phidget.phidgetServer();
  /**
   * Normalize a port into a number, string, or false.
   */

  function normalizePort(val) {
    var port = parseInt(val, 10);

    if (isNaN(port)) {
      // named pipe
      return val;
    }

    if (port >= 0) {
      // port number
      return port;
    }

    return false;
  }

  /**
   * Event listener for HTTP server "error" event.
   */

  function onError(error) {
    if (error.syscall !== 'listen') {
      throw error;
    }

    var bind = typeof port === 'string'
      ? 'Pipe ' + port
      : 'Port ' + port;

    // handle specific listen errors with friendly messages
    switch (error.code) {
      case 'EACCES':
        console.error(bind + ' requires elevated privileges');
        process.exit(1);
        break;
      case 'EADDRINUSE':
        console.error(bind + ' is already in use');
        process.exit(1);
        break;
      default:
        throw error;
    }
  }
