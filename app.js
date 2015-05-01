var debug = require('debug')('traction:server');
var http = require('http');
var express = require('express');
var router = express.Router();
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var passport = require('passport');
var LocalStrategy = require('passport-local').Strategy;
var session = require('express-session');
var RedisStore = require('connect-redis')(session);
var flash = require('connect-flash');
var crypto = require('crypto');
var request = require('request-promise').defaults({
		encoding : null
});
var mqtt = require('mqtt');
var util = require('util');


var Db = new (require('./backend/db.js'))();
var db = Db.connection;
var models = Db.models;

var Broker = new (require('./backend/broker.js'))();
var broker = Broker.connection;

var app = express();
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended : false}));
app.use(cookieParser());
app.use(require('stylus').middleware(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
		store : new RedisStore({
			host : "localhost",
			port : 6379,
			prefix : "traction:sess:"
		}),
		secret : config.SESSION_SECRET,
	}));
app.use(flash());
app.use(function (req, res, next) {
	res.locals.flash_success = req.flash('success');
	res.locals.flash_error = req.flash('error');
	next();
});

// Check supported crypto hashes
debug("Supported hashes: " + crypto.getHashes());

debug("Running pbkdf2 test vector for: sha1");
var p = "password";
var s = "salt";
var kl = 20;
var r = 1;
var h = crypto.pbkdf2Sync(p, s, r, kl);
var hf = new Buffer(h, 'binary').toString('hex');
debug("computed output : " + hf);
debug("expected output  : " + "0c60c80f961f0e71f3a9b524af6012062fe037a6");

debug("Running pbkdf2 test vector for: sha256");
var p = "password";
var s = "salt";
var kl = 32;
var r = 1;
var h = crypto.pbkdf2Sync(p, s, r, kl, "sha256");

crypto.pbkdf2(p, s, r, kl, 'sha256', function (err, key) {
	if (err)
		throw err;
	debug("checking for pbkdf2 sha256 hashes");

	debug("computed output : " + key.toString('hex'));
	debug("expected output  : " + "120fb6cffcf8b32c120fb6cffcf8b32c120fb6cffcf8b32c120fb6cffcf8b32c");
});


// Setup session and login
app.use(passport.initialize());
app.use(passport.session());
passport.use(new LocalStrategy(
	function (username, password, done) {
		return User.findByUsername(username).then(function (user) {
			if (!user) {
				return done(null, false, {
					message : 'Unknown user ' + username
				});
			}

			return user.authenticate(password, done);
		}).catch (function (error) {
			return done(error);
		});
	}
));

passport.serializeUser(function (user, done) {
	done(null, user.id);
});

passport.deserializeUser(function (id, done) {
	return User.findById(id).then(function (user) {
		if (user)
			done(null, user);
	}).catch (function (error) {
		done(error, null);
	})
});


// View routes
app.post('/profile/sync', function (req, res) {
	if (!req.user) {
		return res.redirect('/login');
	}

	req.user.updateFaceAndDevices().then(function () {
		req.flash("success", "Profile synchronized.");
		res.redirect("/profile");
	})
})

app.get('/register', function (req, res) {
	res.render('register');
});

app.get('/devices/add', function (req, res) {
	if (!req.user)
		return res.redirect("/login")

		return res.render('device-add', {
			user : req.user
		});

})

app.post('/devices/add', function (req, res) {
	if (!req.user)
		return res.redirect("/login")

		var devicename = req.body.name;
	if (!devicename) {
		req.flash("error", "A devicename is required to add a new device.");
		return res.redirect("/devices/add");
	}

	console.log("creating device: " + devicename);

	return req.user.addDev(devicename).then(function (device) {
		req.session.plainAccessToken = device.plainAccessToken;
		device.plainAccessToken = undefined;
		req.flash("success", "Device added");
		return res.redirect('/devices/' + device.id);
	}).catch (function (error) {
		console.error(error);
	})
})

app.post('/devices/:id/delete', function (req, res) {
	if (!req.user)
		res.redirect("/login")

		Device.find(req.params.id).then(function (device) {
			if (!device || device.UserId !== req.user.id) {
				req.flash("error", "Deleting the device failed.");
				return res.redirect("/");
			}

			device.clearFace(req.user);
			return device.destroy();
		}).then(function () {
			req.flash("success", "Device deleted.");
			return res.redirect('/');
		}).catch (function (error) {
			req.flash("error", "Deleting the device failed with error: " + error);
			return res.redirect("/")
		})
})

app.post('/devices/:id/reset', function (req, res) {
	if (!req.user)
		res.redirect("/login")

		Device.find(req.params.id).then(function (device) {
			if (!device || device.UserId !== req.user.id) {
				req.flash("error", "Resetting the device credentials failed.");
				return res.redirect("/")
			}

			return device.resetToken();
		}).then(function (device) {
			req.session.plainAccessToken = device.plainAccessToken;
			device.plainAccessToken = undefined;
			req.flash("success", "New device cretentials generated.");
			return res.redirect('/devices/' + device.id);
		}).catch (function (error) {
			console.error(error);
			res.redirect("/")
		})
})

app.get('/devices/:id', function (req, res) {
	if (!req.user)
		return res.redirect("/login")

		Device.find(req.params.id).then(function (device) {
			if (!device || device.UserId !== req.user.id) {
				req.flash("error", "Access denied");
				return res.redirect("/")
			}

			var accessToken = req.session.plainAccessToken;
			var firstStart = req.session.firstStart;

			// Clean up session
			req.session.firstStart = undefined
				req.session.plainAccessToken = undefined;
			res.render('device', {
				device : device,
				user : req.user,
				accessToken : accessToken,
				firstStart : firstStart != undefined
			});
		})
})

app.get('/profile', function (req, res) {
	if (!req.user)
		res.redirect("/login")

		res.render('profile', {
			user : req.user
		});
})

app.get('/profile/edit', function (req, res) {
	if (!req.user)
		res.redirect("/login")

		res.render('profile-edit', {
			user : req.user
		});
})

app.post('/profile/edit', function (req, res, next) {
	if (!req.user)
		res.redirect("/login")

		var currentPassword = req.body.currentPassword;

	var email = req.body.email;
	var newPassword = req.body.newPassword;
	var newPasswordRepeat = req.body.newPasswordRepeat;

	if (email == req.user.email && !newPassword) {
		req.flash('error', "There was nothing to update");
		return res.redirect('/profile/edit');
	}

	req.user.authenticate(currentPassword, function (error, user, message) {
		if (error || !user) {
			req.flash('error', "Incorrect current password");
			return res.redirect('/profile/edit');
		}

		if (newPassword != newPasswordRepeat) {
			req.flash("error", "New passwords do not match");
			return res.redirect('/profile/edit');
		}

		var update = {};
		if (email)
			update['email'] = email;

		if (newPassword)
			update['password'] = newPassword

				return user.updateAttributes(update).then(function () {
					req.flash("success", "Profile updated.");
					return res.redirect('/profile');
				}).catch (function (error) {

					req.flash("error", "Profile update failed: " + error);
					return res.redirect('/profile/edit');
				})
	});
})

app.post('/register', function (req, res, next) {

	var username = req.body.username;
	var email = req.body.email;
	var password = req.body.password;
	var devicename = req.body.devicename;

	if (!username || !password || !devicename || !email) {
		req.flash("error", "Missing a required field");
		return res.render('register');
	}

	var user;

	return User.create({
		username : username,
		email : email,
		password : password
	}).then(function (u) {
		user = u;
		return user.updateFace();
	}).then(function (user) {
		return user.addDev(devicename)
	}).then(function (device) {
		console.log("device access token: " + device.plainAccessToken);
		return req.logIn(user, function (err) {
			if (err) {
				console.log(err);
				next(err)
			}

			req.session.plainAccessToken = device.plainAccessToken;
			device.plainAccessToken = undefined;

			req.session.firstStart = true;

			return res.redirect('/devices/' + device.id);
		});

	}).catch (function (error) {
		req.flash("error", "Registration failed.");
		console.error(error);
		return res.redirect("/register");
	})

});

// Render the login page.
app.get('/login', function (req, res) {
	res.render('login', {
		title : 'Login',
		error : req.flash('error')[0]
	});
});

// Authenticate a user.
app.post('/login', passport.authenticate('local', {
		successRedirect : '/',
		failureRedirect : '/login',
		session : true,
		failureFlash : 'Invalid username or password.'
	}));

// Logout the user, then redirect to the home page.
app.get('/logout', function (req, res) {
	req.logout();
	res.redirect('/');
});

app.get('/', function (req, res) {
	if (!req.user)
		return res.redirect("/login");

	req.user.getDevices().then(function (devices) {
		res.render('dashboard', {
			user : req.user,
			devices : devices
		});
	});
});

// catch 404 and forward to error handler
app.use(function (req, res, next) {
	var err = new Error('Not Found');
	err.status = 404;
	next(err);
});

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
	app.use(function (err, req, res, next) {
		res.status(err.status || 500);
		res.render('error', {
			message : err.message,
			error : err
		});
	});
}

// production error handler
// no stacktraces leaked to user
app.use(function (err, req, res, next) {
	res.status(err.status || 500);
	res.render('error', {
		message : err.message,
		error : {}
	});
});



// Setup and run server
var port = normalizePort(config.port || '3000');
app.set('port', port);
var server = http.createServer(app);

server.listen(port);
server.on('error', onError);
server.on('listening', onListening);

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

function onListening() {
	var addr = server.address();
	var bind = typeof addr === 'string'
		 ? 'pipe ' + addr
		 : 'port ' + addr.port;
	debug('Listening on ' + bind);
}