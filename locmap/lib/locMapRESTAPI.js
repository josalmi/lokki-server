/*
Copyright (c) 2014-2015 F-Secure
See LICENSE for details
*/

'use strict';

/*
    Logic needed for locmap RESTAPI calls.
 */

var logger = require('log-driver').logger;
var LocMapUserModel = require('./locMapUserModel');
var FloodModel = require('../../lib/floodModel');
var LocMapSharingModel = require('./locationShareModel');
var LocMapCommon = require('./locMapCommon');
var locMapCommon = new LocMapCommon();
var LocMapConfig = require('./locMapConfig');
var LocMapCrashReports = require('./crashReports');
var locMapCrashReports = new LocMapCrashReports();
var LocMapEmail = require('./email');
var locMapEmail = new LocMapEmail();
var LocMapResetCode = require('./resetCode');
var locMapResetCode = new LocMapResetCode();
var I18N = require('../../lib/i18n');
var i18n = new I18N();

var check = require('validator').check;
var uuid = require('node-uuid');

var LocMapRESTAPI = function() {
    var restApi = this;

    // executes callback with true as a first argument if authorization succeeded.
    // executes callback with false as a first argument and error string as second one if auth failed. Third parameter is cached UserModel object
    // expects requestBody to contain object with 'authorizationToken'
    this.authorizeUser = function(userId, requestHeader, callback) {
        var user = new LocMapUserModel(userId);
        user.getData(function() {
            if (!user.exists) {
                callback(404, 'User does not exist', user);
            } else if (!user.data.activated || requestHeader === undefined || user.data.authorizationToken.length < 1 || requestHeader.authorizationtoken !== user.data.authorizationToken) {
                callback(401, 'Authorization token is wrong!', user);
            } else {
                // store current version and platform if changed
                if (!user.data.internalData) {
                    user.data.internalData = {};
                }
                var internalDataChanged = (requestHeader.version && requestHeader.version !== user.data.internalData.version);
                if (!internalDataChanged) {
                    internalDataChanged = (requestHeader.platform && requestHeader.platform !== user.data.internalData.platform);
                }
                if (internalDataChanged) {
                    if (requestHeader.version) {
                        user.data.internalData.version = requestHeader.version;
                    }
                    if (requestHeader.platform) {
                        user.data.internalData.platform = requestHeader.platform;
                    }
                    user.setData(function() {
                        callback(200, 'OK', user);
                    }, null);
                } else {
                    callback(200, 'OK', user);
                }
            }
        });
    };

    // executes callback with true as a first argument if request count has not been exceeded.
    // executes callback with false as a first argument and error string as second one if request count exceeded
    this.floodProtection = function(id, type, expireTime, maxRequestCount, callback) {
        var floodId = type + ':' + id;
        var flood = new FloodModel(floodId);
        flood.request(expireTime, maxRequestCount, callback);
    };

    // Resets the specified flood counter.
    // Executes callback with true/false first argument, telling if operation was a success. Just in case caller wants to use it.
    this.resetFloodProtection = function(id, type, callback) {
        logger.warn('Reset called with id ' + id + ' type ' + type);
        var floodId = type + ':' + id;
        var flood = new FloodModel(floodId);
        flood.reset(callback);
    };

    this._formatSignUpReplyData = function(userId, authorizationToken, callback) {
        var reply = {};
        reply.id = userId;
        reply.authorizationtoken = authorizationToken;
        var locShare = new LocMapSharingModel(userId);
        locShare.getData(function(locShareResult) {
            reply.icansee = locShare.data.ICanSee;
            reply.canseeme = locShare.data.canSeeMe;
            if (locShareResult === 404) {  // New user, we should create the entry.
                locShare.setData(function(writeResult) {
                    if (typeof writeResult !== 'number') {
                        callback(reply);
                    } else {
                        callback(writeResult);
                    }
                }, null);
            } else {  // Existing user, use the found data.
                callback(reply);
            }
        });
    };

    // Users recovery mode parameter needs to be a number that is between current time and configured ttl for recovery mode.
    this._isUserInRecoveryMode = function(recoveryMode) {
        var now = Date.now();
        var recoveryModeTimeout = now - LocMapConfig.accountRecoveryModeTimeout * 1000;
        if (typeof recoveryMode === 'number' && recoveryMode <= now && recoveryMode > recoveryModeTimeout) {
            return true;
        } else {
            return false;
        }
    };

    this.signUpUser = function(userData, callback) {
        var that = this;
        if (typeof userData !== 'object' || typeof userData.email !== 'string' || typeof userData.device_id !== 'string') {
            callback(400, 'Invalid data.');
            return;
        }
        try {
            check(userData.email).isEmail();
        } catch (e) {
            logger.trace('User tried signing up with invalid email: ' + userData.email);
            callback(400, 'Invalid email address.');
            return;
        }
        var cleanEmail = userData.email.toLowerCase();
        // TODO Make sure device_id is not empty!!
        var langCode = 'en-US';
        if (userData.language) {
            if (typeof userData.language === 'string' && userData.language.length < 11 && userData.language.length > 1) {
                langCode = userData.language;
            } else {
                callback(400, 'Invalid language code.');
                return;
            }
        }
        var userId = locMapCommon.getSaltedHashedId(cleanEmail);
        var newUser = new LocMapUserModel(userId);
        newUser.getData(function() {
            if (!newUser.exists) {
                newUser.data.email = cleanEmail;
                newUser.data.deviceId = locMapCommon.getSaltedHashedId(userData.device_id);
                newUser.data.authorizationToken = locMapCommon.generateAuthToken();
                newUser.data.language = langCode;
                newUser.data.activated = true;
                newUser.setData(function(result) {
                    if (typeof result !== 'number') {
                        restApi._formatSignUpReplyData(userId, newUser.data.authorizationToken, function(replyResult) {
                            locMapEmail.sendSignupMail(newUser.data.email, langCode, function(emailResult) {
                                if (emailResult) {
                                    logger.trace('Signup email successfully sent to ' + newUser.data.email);
                                } else {
                                    logger.warn('FAILED Signup email sending to ' + newUser.data.email);
                                }
                            });
                            callback(locMapCommon.statusFromResult(replyResult), replyResult);
                        });
                    } else {
                        callback(400, 'Signup error.');
                    }
                }, null);
            } else if (newUser.data.activated) {  // User has been activated already
                if (that._isUserInRecoveryMode(newUser.data.accountRecoveryMode)) {
                    logger.trace('User ' + newUser.data.userId + ' in recovery mode, signing up.');
                    newUser.data.authorizationToken = locMapCommon.generateAuthToken();
                    newUser.data.accountRecoveryMode = 0;
                    newUser.data.language = langCode;
                    newUser.data.deviceId = locMapCommon.getSaltedHashedId(userData.device_id);
                    newUser.setData(function(result) {
                        if (typeof result !== 'number') {
                            restApi._formatSignUpReplyData(userId, newUser.data.authorizationToken, function(replyResult) {
                                // TODO Send some email?
                                callback(locMapCommon.statusFromResult(replyResult), replyResult);
                            });
                        } else {
                            callback(400, 'Signup error.');
                        }
                    });
                } else if (newUser.isMatchingDeviceId(userData.device_id)) { // Device id match, treat as password success and let user in.
                    logger.trace('Device id match for user ' + newUser.data.userId);
                    restApi._formatSignUpReplyData(userId, newUser.data.authorizationToken, function(replyResult) {
                        callback(locMapCommon.statusFromResult(replyResult), replyResult);
                    });
                } else { // Device id mismatch, trigger recovery process for the account.
                    logger.trace('Device id mismatch for user ' + newUser.data.userId);
                    locMapResetCode.createResetCode(newUser.data.userId, function(resetResult) {
                        if (typeof resetResult !== 'number') {
                            logger.trace('Reset code generated for user ' + newUser.data.userId + ' ' + resetResult);
                            locMapEmail.sendResetEmail(newUser.data.email, LocMapConfig.resetLinkAddress + resetResult, newUser.data.language, function(emailResult) {
                                if (emailResult) {
                                    logger.trace('Reset link sent to ' + newUser.data.email);
                                } else {
                                    logger.error('FAILED to send reset link to ' + newUser.data.email);
                                }
                            });
                            callback(401, 'Signup authorization failed.');
                        } else {
                            callback(400, 'Signup error.');
                        }
                    });
                }
            } else {  // User has not been activated ('stub' user) -> Normal signup without overwriting the email.
                newUser.data.deviceId = locMapCommon.getSaltedHashedId(userData.device_id);
                newUser.data.authorizationToken = locMapCommon.generateAuthToken();
                newUser.data.language = langCode;
                newUser.data.activated = true;
                newUser.setData(function(result) {
                    if (typeof result !== 'number') {
                        restApi._formatSignUpReplyData(userId, newUser.data.authorizationToken, function(replyResult) {
                            locMapEmail.sendSignupMail(newUser.data.email, langCode, function(emailResult) {
                                if (emailResult) {
                                    logger.trace('Signup email successfully sent to ' + newUser.data.email);
                                } else {
                                    logger.error('FAILED Signup email sending to ' + newUser.data.email);
                                }
                            });
                            callback(locMapCommon.statusFromResult(replyResult), replyResult);
                        });
                    } else {
                        callback(result, 'Failed to save new user data.');
                    }
                }, null);
            }
        });
    };

    // Pick shareable user data from the user data object.
    this._filterUserShareData = function(userData) {
        var shareData = {};
        shareData.location = JSON.parse(JSON.stringify(userData.location));
        shareData.visibility = JSON.parse(JSON.stringify(userData.visibility));
        shareData.battery = JSON.parse(JSON.stringify(userData.battery));
        return shareData;
    };

    // Get data for users that allow current to see them. Currently contains only location.
    this._getUserShareData = function(userIdList, callback) {
        var that = this;
        var userShareData = {};
        var counter = userIdList.length;
        if (counter === undefined || counter < 1) {
            callback(userShareData);
            return;
        }

        function loadUserShareData(userData) {
            counter--;
            if (typeof userData !== 'number') {
                userShareData[userData.userId] = that._filterUserShareData(userData);
            }
            if (counter <= 0) { // All queries done.
                callback(userShareData);
            }
        }

        for (var i = 0; i < userIdList.length; ++i) {
            var userId = userIdList[i];
            var user = new LocMapUserModel(userId);
            user.getData(loadUserShareData);
        }
    };

    // Generates id - email mapping from two id lists.
    this._generateIdMapping = function(ICanSee, canSeeMe, callback) {
        var idMapping = {};

        var combinedLists = locMapCommon.combineListsUnique(ICanSee, canSeeMe);

        // Find emails for the ids.
        var counter = combinedLists.length;
        if (counter < 1) {
            callback(idMapping);
            return;
        }

        function loadUser(userData) {
            counter--;
            if (typeof userData !== 'number') {
                // TODO Drop / mark users without email?
                idMapping[userData.userId] = userData.email;
            }
            if (counter <= 0) { // All queries done.
                callback(idMapping);
            }
        }

        for (var i = 0; i < combinedLists.length; i++) {
            var userId = combinedLists[i];
            var user = new LocMapUserModel(userId);
            user.getData(loadUser);
        }
    };

    this.getUserDashboard = function(userId, cache, callback) {
        var that = this;
        var user = cache.get('locmapuser', userId);
        var responseData = {};
        responseData.location = user.data.location;
        responseData.visibility = user.data.visibility;
        responseData.battery = user.data.battery;
        var locShare = new LocMapSharingModel(userId);
        locShare.getData(function(locShareResult) {
            if (typeof locShareResult !== 'number') {
                responseData.canseeme = locShare.data.canSeeMe;
                that._getUserShareData(locShare.data.ICanSee, function(ICanSeeData) {
                    responseData.icansee = ICanSeeData;
                    that._generateIdMapping(locShare.data.ICanSee, locShare.data.canSeeMe, function(idMappingData) {
                        responseData.idmapping = idMappingData;
                        responseData.idmapping[userId] = user.data.email;  // Include current user info into mapping.
                        // Update user dashboard access timestamp.
                        user.setLastDashboardRead(function(dashUpdateResult) {
                            if (dashUpdateResult !== 'OK') {
                                logger.warn('Failed to update last dashboard access for user ' + userId);
                            }
                        });
                        callback(200, responseData);
                    });
                });
            } else {
                logger.warn('Failed to get dashboard for user ' + userId);
                callback(404, 'Failed to get dashboard data for user.');
            }
        });
    };

    this.changeUserLocation = function(userId, cache, reportData, callback) {
        if (!reportData) {
            callback(400, 'Location object is wrong!');
            return;
        }
        var location = reportData.location;
        if (!location || (typeof location !== 'object') || location.lat === undefined || location.lon === undefined || location.acc === undefined) {
            callback(400, 'Location object is wrong!');
            return;
        }
        var strippedLocation = locMapCommon.verifyLocation(location);
        if (strippedLocation === null) {
            callback(400, 'Location object is wrong!');
            return;
        }
        var cleanBattery = '';
        if (reportData.battery !== undefined && typeof reportData.battery === 'number') {
            cleanBattery = reportData.battery;
        }

        var user = cache.get('locmapuser', userId);
        user.setLocationAndBattery(strippedLocation, cleanBattery, function(result) {
            callback(locMapCommon.statusFromResult(result), result);
        });

    };

    this._storeAllowUser = function(currentUserLocShare, otherUserLocShare, callback) {
        currentUserLocShare.allowOtherUser(otherUserLocShare.data.userId, function(mResult) {
            if (typeof mResult !== 'number') {
                otherUserLocShare.addUserICanSee(currentUserLocShare.data.userId, function(oResult) {
                    callback(locMapCommon.statusFromResult(oResult));
                });
            } else {
                callback(mResult);
            }
        });
    };

    this._allowUserToSee = function(currentUserLocShare, currentUserEmail, targetEmail, callback) {
        var that = this;
        try {
            check(targetEmail).isEmail();
        } catch (e) {
            logger.trace('User ' + currentUserLocShare.data.userId + ' tried to allow invalid email address: ' + targetEmail);
            callback(400);
            return;
        }
        var cleanTargetEmail = targetEmail.toLowerCase();
        var otherUserId = locMapCommon.getSaltedHashedId(cleanTargetEmail);

        if (currentUserLocShare.data.userId === otherUserId) {
            callback(400);
            return;
        }

        var otherLocShare = new LocMapSharingModel(otherUserId);
        otherLocShare.getData(function(otherLocShareResult) {
            // Non-existing user, create a stub for it with the email.
            if (otherLocShareResult === 404) {
                var newUser = new LocMapUserModel(otherUserId);
                logger.trace('Creating stub user, id: ' + otherUserId + ' email ' + cleanTargetEmail);
                newUser.data.email = cleanTargetEmail;
                newUser.setData(function(result) {
                    if (typeof result !== 'number') {
                        locMapEmail.sendInviteEmail(cleanTargetEmail, currentUserEmail, 'en-US', function(emailResult) {
                            if (emailResult) {
                                logger.trace('Invite email sent to ' + cleanTargetEmail + ', inviter: ' + currentUserEmail);
                            } else {
                                logger.error('FAILED to send invite email to ' + cleanTargetEmail);
                            }
                            that._storeAllowUser(currentUserLocShare, otherLocShare, callback);
                        });
                    } else {
                        callback(400);
                    }
                }, null);
            } else if (typeof otherLocShareResult !== 'number') {
                that._storeAllowUser(currentUserLocShare, otherLocShare, callback);
            } else {
                callback(400);
            }
        });
    };

    this.allowToSeeUserLocation = function(userId, cache, targetUsers, callback) {
        // Posted emails-array gets converted to an object that just looks like an array.
        if (typeof targetUsers !== 'object' || typeof targetUsers.emails !== 'object') {
            logger.warn('Invalid data for allow user.');
            callback(400, 'Invalid data.');
            return;
        }
        var that = this;
        var counter = targetUsers.emails.length;
        var errorCount = 0;
        if (typeof counter !== 'number' || counter < 1) {
            logger.warn('At least one email required for allow user.');
            callback(400, 'Invalid data.');
            return;
        }
        var cacheUser = cache.get('locmapuser', userId);
        var currentUserEmail = cacheUser.data.email;
        var currentUserLocShare = new LocMapSharingModel(userId);

        function handleAllowResult(allowResult) {
            if (allowResult !== 200) {
                errorCount++;
            }
            counter--;
            if (counter <= 0) { // All queries done.
                if (errorCount > 0) {
                    logger.warn('WARNING Failed to allow ' + errorCount + ' of ' + targetUsers.emails.length + ' users.');
                    callback(400);
                } else {
                    callback(200);
                }
            }
        }

        currentUserLocShare.getData(function() {
            if (currentUserLocShare.exists) {
                for (var i = 0; i < targetUsers.emails.length; ++i) {
                    that._allowUserToSee(currentUserLocShare, currentUserEmail, targetUsers.emails[i], handleAllowResult);
                }
            } else {
                callback(404, 'User not found.');
            }
        });
    };

    this.denyToSeeUserLocation = function(userId, cache, targetUserId, callback) {
        var myLocShare = new LocMapSharingModel(userId);
        myLocShare.getData(function() {
            if (myLocShare.exists) {
                var otherLocShare = new LocMapSharingModel(targetUserId);
                otherLocShare.getData(function(otherLocShareResult) {
                    if (typeof otherLocShareResult !== 'number') {
                        myLocShare.denyOtherUser(targetUserId, function(mResult) {
                            if (typeof mResult !== 'number') {
                                otherLocShare.removeUserICanSee(userId, function(oResult) {
                                    callback(locMapCommon.statusFromResult(oResult), oResult);
                                });
                            } else {
                                callback(mResult);
                            }
                        });
                    } else {
                        callback(otherLocShareResult, 'Error getting data for other user.');
                    }
                });
            } else {
                callback(404, 'User does not exist.');
            }
        });
    };

    this.setUserApnToken = function(userId, apnToken, callback) {
        var user = new LocMapUserModel(userId);
        user.setPushNotificationToken({apn: apnToken}, function(result) {
            callback(locMapCommon.statusFromResult(result), result);
        });
    };

    this.setUserGcmToken = function(userId, gcmToken, callback) {
        var user = new LocMapUserModel(userId);
        user.setPushNotificationToken({gcm: gcmToken}, function(result) {
            callback(locMapCommon.statusFromResult(result), result);
        });
    };

    this.setUserWP8Token = function(userId, URL, callback) {
        var user = new LocMapUserModel(userId);
        user.setPushNotificationToken({wp8: URL}, function(result) {
            callback(locMapCommon.statusFromResult(result), result);
        });
    };

    this._pollUserLocation = function(userId, callback) {
        var user = new LocMapUserModel(userId);
        user.getData(function(userData) {
            if (typeof userData !== 'number') {
                if (user.data.visibility) {
                    if (locMapCommon.isLocationTimedout(user.data.location, LocMapConfig.locationNotificationTimeout)) {
                        user.sendNotLocalizedPushNotification('locationRequest', undefined, true, true);
                    } else {
                        logger.trace('Skipping notification to user ' + userId + ' location not timed out.');
                    }
                } else {
                    logger.trace('Skipping notification to user ' + userId + ' visibility set to hide.');
                }
            }
            callback(userData);
        });
    };

    // Send notification for each user to update their location.
    this._pollUserLocations = function(userIdList, callback) {
        var that = this;
        var counter = userIdList.length;
        if (counter === undefined || counter < 1) {
            callback(200);
            return;
        }

        function handleResult() {
            counter--;
            if (counter <= 0) { // All queries done.
                callback(200);
            }
        }

        for (var i = 0; i < userIdList.length; ++i) {
            var userId = userIdList[i];
            that._pollUserLocation(userId, handleResult);
        }
    };

    this.requestUserLocationUpdates = function(userId, callback) {
        var that = this;
        var locShare = new LocMapSharingModel(userId);
        locShare.getData(function() {
            if (locShare.exists) {
                logger.trace('User ' + userId + ' requesting user location updates.');
                that._pollUserLocations(locShare.data.ICanSee, callback);
            } else {
                callback(404, 'User does not exist.');
            }
        });
    };

    // Toggle user visibility
    this.setUserVisibility = function(userId, cache, settingsObject, callback) {
        if (typeof settingsObject !== 'object' || typeof settingsObject.visibility !== 'boolean') {
            callback(400, 'Invalid data.');
            return;
        }
        var user = cache.get('locmapuser', userId);

        user.setVisibility(settingsObject.visibility, function(result) {
            logger.trace('Visibility set to ' + settingsObject.visibility + ' for user ' + userId + ' with result ' + result);
            callback(locMapCommon.statusFromResult(result), result);
        });
    };

    // Set user language
    this.setUserLanguage = function(userId, cache, settingsObject, callback) {
        if (typeof settingsObject !== 'object' || typeof settingsObject.language !== 'string' ||
            settingsObject.language.length > 10 || settingsObject.language.length < 2) {
            callback(400, 'Invalid data.');
            return;
        }
        var user = cache.get('locmapuser', userId);

        user.setLanguage(settingsObject.language, function(result) {
            logger.trace('Language set to ' + settingsObject.language + ' for user ' + userId + ' with result ' + result);
            callback(locMapCommon.statusFromResult(result), result);
        });
    };

    this.storeCrashReport = function(userId, reportObject, callback) {
        if (typeof reportObject !== 'object' || typeof reportObject.lokkiVersion !== 'string' || typeof reportObject.reportTitle !== 'string' || typeof reportObject.reportData !== 'string' || typeof reportObject.osType !== 'string') {
            callback(400, 'Invalid report object.');
            return;
        }
        var osType = reportObject.osType;
        if (osType !== 'android' && osType !== 'ios' && osType !== 'wp') {
            callback(400, 'Invalid os type.');
            return;
        }
        locMapCrashReports.store(userId, osType, reportObject, function(status, result) {
            callback(status, result);
        });
    };

    /* TODO Finalize if we take account recovery by confirmation code into use.
    this.setUserAccountRecovery = function(dataObject, callback) {
        if (typeof dataObject !== 'object' || typeof dataObject.email !== 'string') {
            callback(400, 'Invalid post data.');
            return;
        }
        var userEmail = dataObject.email;
        try {
            check(userEmail).isEmail();
        } catch (e) {
            logger.error('User tried recovery with invalid email: ' + userEmail);
            callback(400, 'Invalid email address.');
            return;
        }
        var userId = LocMapCommon.getSaltedHashedId(userEmail);
        var user = new LocMapUserModel(userId);
        user.getData(function(result) {
            if (user.exists) {


            } else {
                callback(404, 'User does not exist.');
            }
        });
    };
    */

    // Reset link clicked, check the code and set corresponding user to recovery mode.
    this.resetUserAccountToRecoveryMode = function(resetId, callback) {
        locMapResetCode.getResetCodeData(resetId, function(resetData) {
            if (typeof resetData !== 'number' && typeof resetData === 'object' && typeof resetData.userId === 'string' && resetData.userId.length > 0 && typeof resetData.resetCode === 'string' && resetData.resetCode.length > 0) {
                locMapResetCode.removeResetCode(resetId, function(removeResult) {
                    if (removeResult !== 1) {
                        logger.warn('Failed to delete reset code for user ' + resetData.userId + ' (code: ' + resetId + ')');
                    }
                    var user = new LocMapUserModel(resetData.userId);
                    user.getData(function() {
                        if (user.exists) {
                            user.setAccountRecoveryMode(Date.now(), function(modeSetResult) {
                                if (typeof modeSetResult !== 'number') {
                                    var lang = locMapCommon.verifyLangCode(user.data.language);
                                    callback(200, i18n.getLocalizedString(lang, 'reset.serverMessage'));
                                } else {
                                    callback(400, 'Failed to put user account into recovery mode.');
                                }
                            });
                        } else {
                            callback(404, 'User not found.');
                        }
                    });
                });
            } else {
                callback(404, 'Reset code not found.');
            }
        });
    };

    // Add a new place to user.
    this.addUserPlace = function(userId, cache, placeObj, callback) {
        // Verify place data.
        if (!placeObj) {
            callback(400, 'Place object is wrong!');
            return;
        }
        var place = placeObj;
        if (!place || (typeof place !== 'object') || place.lat === undefined || place.lon === undefined || place.rad === undefined || place.name === undefined || place.img === undefined) {
            callback(400, 'Place object is wrong!');
            return;
        }
        var strippedPlace = locMapCommon.verifyPlace(place);
        if (strippedPlace === null) {
            callback(400, 'Place object is wrong!');
            return;
        }

        var user = cache.get('locmapuser', userId);
        if (Object.keys(user.data.places).length >= LocMapConfig.maxPlacesLimitNormalUser) {
            callback(403, 'Place limit reached.');
            return;
        }

        var placeId = uuid.v4();
        user.data.places[placeId] = strippedPlace;
        user.setData(function(result) {
            if (typeof result !== 'number') {
                callback(200, {'id': placeId});
            } else {
                callback(locMapCommon.statusFromResult(result), result);
            }
        });
    };

    // Get user places.
    this.getUserPlaces = function(userId, cache, callback) {
        var user = cache.get('locmapuser', userId);
        callback(200, user.data.places);
    };

    // Modify an existing place.
    this.modifyUserPlace = function(userId, cache, placeId, placeObj, callback) {
        // Verify place data.
        if (!placeObj) {
            callback(400, 'Place object is wrong!');
            return;
        }
        var place = placeObj;
        if (!place || (typeof place !== 'object') || place.lat === undefined || place.lon === undefined || place.rad === undefined || place.name === undefined || place.img === undefined) {
            callback(400, 'Place object is wrong!');
            return;
        }
        var strippedPlace = locMapCommon.verifyPlace(place);
        if (strippedPlace === null) {
            callback(400, 'Place object is wrong!');
            return;
        }

        var user = cache.get('locmapuser', userId);
        if (user.data.places.hasOwnProperty(placeId)) {
            user.data.places[placeId] = strippedPlace;
            user.setData(function(result) {
                callback(locMapCommon.statusFromResult(result), result);
            });
        } else {
            callback(404, 'Place not found.');
        }
    };

    // Remove an existing place.
    this.removeUserPlace = function(userId, cache, placeId, callback) {
        var user = cache.get('locmapuser', userId);
        if (user.data.places.hasOwnProperty(placeId)) {
            delete user.data.places[placeId];
            user.setData(function(result) {
                callback(locMapCommon.statusFromResult(result), result);
            });
        } else {
            callback(404, 'Place not found.');
        }
    };

};

module.exports = LocMapRESTAPI;
