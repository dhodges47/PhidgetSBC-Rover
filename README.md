# Phidgets Rover
A 4 wheel driver rover, controlled by Phidgets components (https://www.phidgets.com).
The chassis is a Nomad from ServoCity.

The brains of the rover is a Phidgets SBC4 (Single Board Computer).
The rover communicates with the control program using a private wi-fi hotspot hosted by the Phidgets SBC4.
The control program runs on a laptop. It is written entirely in javascript using Node.js.
It allows you to remote control the rover using a Phidgets Thumbstick.

Rover capabilities:
1. Independent control of each wheel's motor: start, accelerate, stop
2. Differential steering, in which steering is accomplished by controlled the rate of speed of the left and right-side motors.
3. Front and rear sonar sensors. These are used for distance readings and for detecting proximity to barriers. The software will stop the rover if it gets too close to a barrier.
4. Telemetry data stream back to the host program, including velocity, distance, temperature, voltages, and other values.
5. Live video camera feed

Thumbstick capabilities:
While it is a simple control, similar to one thumbstick on a game controller, this device is all we need to control the robot.
It has an X axis, which governs steering, and a Y axis, which governs velocity. The combination of X and Y values create a vector for direction and speed.
It also has a digital pushbutton. If you push down on the thumbstick, it creates an event. We have programmed that button to be an emergency brake. When clicked, it will bring the rover to a halt.


![Stalker Rover](/public/images/DSC_6977-edited.jpg){:height="50%" width="50%"}


**Hardware**

Phidgets SBC4

4 Phidget DC Motor Controllers (DC1000)
Each controller handles 1 motor. These controllers monitor power surges and overheating, and connect to the SBC4 with VINT cables.

2 Phidget Sonar Sensors (DST1200). These are for measuring distance to the nearest obstacle.

Phidget Thumbstick HIN1100 and Vint Hub Phidget HUB0000.


Hardware Chassis: Nomad from ServoCity: https://www.servocity.com/nomad  It includes 4 DC Motors.

2 LiPo batteries

Various wires, switches,  and cable ties.


**Software**



    Visual Studio Code

    Node.js and various libraries (see below)

    Javascript

    This repository

Notes about this Repository
While there are many files in this repository, the following are the key files to look at to understand how the rover software works:

app.js - the main loop of the node.js server application. It communicates with the web page using sockets.io.
phidgetServer.js - This script relays commands from app.js to the Rover, and relays telemetry data from the Rover to app.js, for sending to the web page.
constants.js - This script contains global variables for both app.js and phidgetServerjs.
Inter-process communication between app.js and phidgetServer.js uses pubsub.js for asynchronous message queuing.

public/index.html - the Web Page that provides the user interface for the Rover.
public/js/PhidgetsRover.js - this script is the interface between the web page and the node.js server, for two-way communicaton using sockets.io.
public/js/ThumbStick.js - this script handles the ThumbStick interface between the local PhidgetsServer and the node.js server.


Detailed notes on setting up the software:

Software can be developed either on a Mac or on Windows.

Install Visual Studio Code ( https://code.visualstudio.com/)

Install Nodejs (go to Nodejs.org and download the package and install it)

Create a folder called "Robotics".

Then in Visual Studio Code, open the robotics folder. It will be empty at this point.

From the top menu, go to terminal, new terminal.

A command window will open. Execute the following commands, one by one.
```
npm install -g express

express --no-view --git PhidgetsRover

cd PhidgetsRover

npm install

npm install phidget22

npm install pubsub-js

npm install maths

nom install socket.io

nom install diff-steer

npx gitignore node
```
Click the source control icon and then "create repository" from the top menu.

This will create a git repository and will stage all the files that have been generated or added to your new application.

Then Enter a commit message like "Initial Commit" and click cmd-enter to initialize all your files in source control.

Not only does this help prevent you from disaster if you make accidental changes, but it keeps a record of the growth of your app.

Commit early, commit often. (Every development day, at least)

Now you are ready to clone the repository into the PhidgetsRover folder, making sure that app.js, phidgetsServer.js, and constants.js are in the root of the PhidgetsRover Folder.

In Visual Studio Code, create 2 more files in the PhidgetsRover folder:

app.js is the starting point and main loop of the server application. It manages communication with the browser. It serves the web page to the requesting browser, and sets up two way communication with it using socket.io.

It also sets up two way communication with the phidgetServer using pubsub.js.

phidgetServer.js is the script that talks to the rover. It sends commands to the rover, and relays back status information.

constant.js contains names for values that are shared between app.js and phidgetServer.js. It also contains names for values that might change, like the id's for the various controllers. The idea for constants is that, if the values change, you just have to change them in the constant file, rather than searching and replacing them in all the code.

After cloning the repository from GitHub, you will find a public folder. This contains the index.html and supporting files for the web page that displays the Control Panel to the user.

If all is well, you should be able to run the program in Visual Studio using the debug tab, with a nodes profile.

Then, if you open a web page to http://localhost:3001, you should see the Control Panel.

** A note about the Phidgets Server **

Phidgets provides the low-level interface to their hardware components, which make it an excellent platform for rapid development of software controlled hardware projects.
Phidgets also provides their Phidgets Server, which provides an interface to their components that doesn't require any programming.

There are two Phidgets servers, and a Node.js web server, running in this project:
1) On the rover itself, the SBC4 is running a Phidgets Server by default. This server provides the API that is used for remote control of the vehicle.
2) On the laptop, we also need to run the Phidgets Server, but for only one purpose: to interface to the Thumbstick control. Thumbstick data goes through a VINT connection to a USB port on the laptop, where it is read by the Phidgets Server. There is a script called "thumbstick.js" in the public/js folder that gets Thumbstick data from the Phidgets Server.
3) On the laptop we also run a node.js server in order to host the code in this repository. This server provides serveral functions:
a) It communicates with the Phidgets Server on the Rover's SBC4 via wi-fi, through the phidget22.js library that is available on the phidgets web site.
b) It hosts a web page that runs in a browser on the laptop at the address http://localhost:3001. It receives commands from the web page (and thumbstick) and relays them to the rover. It also collects rover telemetry data and sends it back to the web page for display.
