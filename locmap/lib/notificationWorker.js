/*
Copyright (c) 2014-2015 F-Secure
See LICENSE for details
*/

'use strict';

/*
    Upkeep method that goes through the stored pending notifications in Redis
    and checks if user needs to be polled with a visible notification.
 */

var logger = require('log-driver').logger;
var db = require('../../lib/db');
var LocMapConfig = require('./locMapConfig');
var PendingNotifications = require('./pendingNotifications');
var pendingNotifications = new PendingNotifications();
var LocMapUserModel = require('./locMapUserModel');

var lockDBKey = 'pendingNotificationCheckLock';

var checkNotifications = function() {
    var checkNotify = this;

    this._checkAndNotifyUser = function(userId, notificationTime, callback) {
        var user = new LocMapUserModel(userId);
        user.getData(function() {
            if (user.exists) {
                var recentLocationUpdate = false;
                var recentVisibleNotification = false;
                var hasCorrectDevice = false;
                var isVisible = false;

                // If user location has been updated after pending notification timestamp.
                if (typeof user.data.location === 'object' && typeof user.data.location.time === 'number') {
                    if (user.data.location.time >= notificationTime) {
                        recentLocationUpdate = true;
                    }
                }
                // Check if user has received a visible notification recently.
                if (typeof user.data.lastVisibleNotification === 'number') {
                    var now = Date.now();

                    if (user.data.lastVisibleNotification + LocMapConfig.visibleNotificationLimit * 1000 >= now) {
                        recentVisibleNotification = true;
                    }
                }

                // Check if user is using an APN token, visible notifications are sent to Apple devices.
                if (user.data.apnToken) {
                    hasCorrectDevice = true;
                }

                // Double check if user is active and visible, we shouldn't bother invisible users.
                if (user.data.activated && user.data.visibility) {
                    isVisible = true;
                }

                // Send notification if users location has not updated recently, or they have not been sent a notification rencently.
                if (!recentLocationUpdate && !recentVisibleNotification && hasCorrectDevice && isVisible) {
                    user.sendLocalizedPushNotification('notify.friendLocationRequestLokkiStart', function() {
                        logger.trace('Visible notification sent to user ' + user.data.userId);
                        callback(true);
                    });
                } else {
                    callback(false);
                }
            } else {
                callback(false);
            }
        });
    };

    // Clean notifications list so that only one notification per user is left.
    this._cleanNotifications = function(notifications) {
        var uniqueNotifications = [];
        var userIds = {};
        for (var i = 0; i < notifications.length; i++) {
            var notification = notifications[i];
            if (userIds.hasOwnProperty(notification.userId)) {
                continue;
            } else {
                userIds[notification.userId] = true;
                uniqueNotifications.push(notification);
            }
        }
        return uniqueNotifications;
    };

    this.doNotificationsCheck = function(callback) {
        // Acquire lock for the check. This prevents multiple instances from doing the upkeep simultaneously.
        db.set(lockDBKey, 'anyvalue', 'NX', 'EX', LocMapConfig.notificationCheckPollingInterval, function(error, result) {
            if (result === 'OK') {
                pendingNotifications.getTimedOutNotifications(LocMapConfig.pendingNotificationTimeout, function(notifications) {
                    if (notifications.length > 0) {
                        var cleanNotifications = checkNotify._cleanNotifications(notifications);
                        var count = 0;
                        var notifyCount = 0;

                        var notifiedCallback = function(notified) {
                            if (notified) {
                                notifyCount++;
                            }
                            count++;
                            if (count >= cleanNotifications.length) {
                                logger.info('CheckNotifications sent ' + notifyCount + ' visible notifications. Checked ' + cleanNotifications.length + ' pending notifications. Dropped ' + (notifications.length - cleanNotifications.length) + ' duplicates.');
                                if (callback) {
                                    callback(notifyCount);
                                }
                            }
                        };

                        for (var i = 0; i < cleanNotifications.length; i++) {
                            var notification = cleanNotifications[i];
                            checkNotify._checkAndNotifyUser(notification.userId, notification.timestamp, notifiedCallback);
                        }
                    } else if (callback) {
                        callback(0);
                    }
                });
            } else if (callback) {
                callback(undefined);
            }
        });
    };
};

module.exports = checkNotifications;
