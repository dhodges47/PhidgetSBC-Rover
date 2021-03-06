
//ThumbStick Transport Object to send X and Y axis values to server
var TSTransport = {};
// axes (ie thumbsticks)
TSTransport.X = 0.0;  // velocity
TSTransport.Y = 0.0;  // steering
//
  // initialize distance for the distance sensors
  //
  var distanceFront = 0;
  var distanceRear = 0;

// initialize socket communication with server
var socket;

// Global variable to indicate whether rover is stopped or not
var isRoverStopped = true;


$(function() {
    //
    // initialize thumbstick
    //
    window.thumbStick = new ThumbStick();
    thumbStick.ThumbConnect();
    //
    // initialize socket for communication with the server
    //
    socket = io("http://localhost:3001");
    //
    // get references to gauges
    //
  var gauge1 = document.gauges.get("gaugeMotor1");
  var gauge2 = document.gauges.get("gaugeMotor2");
  var gauge3 = document.gauges.get("gaugeMotor3");
  var gauge4 = document.gauges.get("gaugeMotor4");



  // handle various socket messages from the server
  socket.on("connectionStatus", function(data) {
    UpdateRoverConnectionStatus(data);
  });
  socket.on("telemetry", function(t) {
    var telemetry = JSON.parse(t);
    if (telemetry.sourceName) {
      switch (telemetry.sourceName) {
        case "DCMotor":
          if (telemetry.event == "velocity") {
            var v = telemetry.value;
            var e = telemetry.event;
            var hubPort = telemetry.sourceIndex;
            switch (hubPort) {
              case 0:
                gauge1.value = Math.abs(v * 100);
                break;
              case 1:
                gauge2.value = Math.abs(v * 100);
                break;
              case 2:
                gauge3.value = Math.abs(v * 100);
                break;
              case 3:
                gauge4.value = Math.abs(v * 100);
                break;
            }
            SetIsRoverStopped(v);
          }
          break;
        case "temperatureSensor":
          if (telemetry.event == "temperature") {
            var celsius = telemetry.value;
            var hubPort = telemetry.sourceIndex;
            var farenheit = ((celsius * 9) / 5 + 32).toFixed(2);
            // note: Phidgets maximum operating temp is 85 C, or 185F
            // we'll display an alert if it gets close to that number
            var maxCelsius = 85;
            if (celsius >= maxCelsius)
            {
              $("#lblTemperatureAlert").text("Controller temperature is dangerously high!");
            }
            else{
              $("#lblTemperatureAlert").text("");
            }
            switch (hubPort) {
              case 0:
                $("#lblMotorOneStatus").text(`Temperature: ${farenheit} F`);
                break;
              case 1:
              $("#lblMotorTwoStatus").text(`Temperature: ${farenheit} F`);
              break;
                break;
              case 2:
              $("#lblMotorThreeStatus").text(`Temperature: ${farenheit} F`);
              break;
                break;
              case 3:
              $("#lblMotorFourStatus").text(`Temperature: ${farenheit} F`);
              break;
                break;
            }
          }
          break;
        case "distanceSensor":
          if (telemetry.event == "distance") {
            var distanceSensor = telemetry.sourceIndex; // will be either "front" or "back"
            var distance = telemetry.value;
            if (distanceSensor == "front") {
              distanceFront = telemetry.value;
            }
            else{
              distanceRear = telemetry.value;
            }
            if (distanceFront <= 80 || distanceRear <= 80) // 80 mm = 3 inches

            {
              // too close to obstacle, so stop the rover
              if (! isRoverStopped)
              {
                socket.emit("steering", "0");
                socket.emit("velocity", "0");
                resetSliders();
                SetIsRoverStopped(0);
                $("#lblProximityAlert").text(`Too close to obstacle, stopping rover.`);
              }
            }
            if (distanceFront >= 170 && distanceRear >= 170)
            {
              $("#lblProximityAlert").text('');
            }
            else
            {
            if (distanceSensor == "front" && distanceFront < 170) {
              $("#lblProximityAlert").text(`Getting close to obstacle: Front sensor distance is ${distanceFront} mm`);

            } else if(distanceSensor == "back" && distanceRear < 170){
              $("#lblProximityAlert").text(`Getting close to obstacle: Rear sensor distance is ${distanceRear} mm`);
            }
            }
          }
          break;
      }
    }
  });
  socket.on("errorReport", function(data) {
    var errorMessage = data;
    $("#lblError").text(errorMessage);
  });
  //
  // button event handlers
  //
  btnConnect_onClick = function() {
    $("#ledConnectionStatus").attr("class", "led-yellow");
    $("#lblRoverStatus").text('Connecting');
    socket.emit("connectRover", "true");
    startThumbStick();
    resetSliders();
    return false;
  };
  btnDisConnect_onClick = function() {
    $("#ledConnectionStatus").attr("class", "led-yellow");
    $("#lblRoverStatus").text('DisConnecting');
    socket.emit("connectRover", { setting: "false" });
    stopThumbStick();
    resetSliders();
    return false;
  };
  btnStopMotor_onClick = function() {
    socket.emit("steering", "0");
    socket.emit("velocity", "0");
    resetSliders();
    SetIsRoverStopped(0)
  };
  btnCancelSteering_onClick = function() {
    socket.emit("steering", 0);
    document.getElementById("sliderSteering").value = "0";
    document.getElementById("steerVector").value = "";
  };
  // slider event handlers
  $("#sliderVelocity").on("input", function() {
    var newVelocity = $(this).val();
    if (newVelocity < 7 && newVelocity > -7) {
      newVelocity = 0;
    }
    socket.emit("velocity", newVelocity);
  });
  $("#sliderSteering").on("input", function() {
    var newSteering = $(this).val();
    if (newSteering < 1 && newSteering > -1) {
      newSteering = 0;
      document.getElementById("sliderSteering").value = "0";
    }
    socket.emit("steering", newSteering);
  });


  console.log("ready!");
}); // end of document.ready section
function SetIsRoverStopped(v) {
  if (v == 0) {
    isRoverStopped = true;
  }
  else {
    isRoverStopped = false;
  }
}

//
  // handlers for ThumbStick
  //
  function onThumbStick(msg, _TSTransport)
    {
      // thumbstick values contain both velocity and steering (X and Y)
      // check to see if thumbstick values have changed
      // and if so, send them to the server.
      if (! compareThumbStickValues(_TSTransport.X, _TSTransport.Y))
      {
        TSTransport.X = _TSTransport.X;
        TSTransport.Y = _TSTransport.Y;
        ThumbStickSocket(JSON.stringify(TSTransport)); // send to server
      }

    }
    function onThumbStickButton(msg, state)
    {
      // state is always "true" if button is pressed, and "False" when the button is let go again.
        console.log("Thumbstick Button Press: " + state)
        if (state === true)
        {
          // stop the rover
          socket.emit("steering", "0");
          socket.emit("velocity", "0");
        }
    }
    function ThumbStickSocket(objGP) {
        socket.emit("ThumbStick", objGP);
      }
    var token1;
    var token2;
    startThumbStick = function() {
      //
      // subscribe to events from the ThumbStick
      //
      token1 = PubSub.subscribe("thumbstick", onThumbStick);
      token2 = PubSub.subscribe(
        "thumbstick-digitalInput",
        onThumbStickButton
      );
    };
stopThumbStick = function () {
    //
    // un-subscribe to events from the ThumbStick
    //
    PubSub.unsubscribe(token1);
    PubSub.unsubscribe(token2);
}
UpdateRoverConnectionStatus = function(data) {
  if (data == "Rover is connected") {
    $("#ledConnectionStatus").attr("class", "led-green");
    $("#lblRoverStatus").text('Connected');
    bRover = true;
  } else {
    $("#ledConnectionStatus").attr("class", "led-red");
    $("#lblRoverStatus").text('Disconnected');
    bRover = false;
  }
};
resetSliders = function() {
  document.getElementById("sliderVelocity").value = "0";
  document.getElementById("sliderSteering").value = "0";
  document.getElementById("velocity").value = "";
  document.getElementById("steerVector").value = "";
};
var compareThumbStickValues = function(X, Y)
{
  if (TSTransport.X === X && TSTransport.Y === Y)
  {
    return true;
  }
  return false;
}
