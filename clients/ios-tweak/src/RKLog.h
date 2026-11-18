#pragma once
#import <UserNotifications/UserNotifications.h>

void RKLog(NSString *msg);

void RKLogNote(NSString *where, NSString *ident, UNNotificationContent *content,
               NSDictionary *userInfo);
void RKLogRequest(NSString *where, UNNotificationRequest *req);
