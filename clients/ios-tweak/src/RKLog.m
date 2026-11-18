#import "RKLog.h"
#import <os/log.h>

void RKLog(NSString *msg) {
  static os_log_t log;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    log = os_log_create("fun.tica.rk.ios", "push");
  });
  os_log(log, "%{public}@", msg);
}

void RKLogNote(NSString *where, NSString *ident, UNNotificationContent *content,
               NSDictionary *userInfo) {
  RKLog([NSString stringWithFormat:@"%@ | id=%@ title=%@ body=%@ userInfo=%@",
                                   where, ident, content.title, content.body,
                                   content.userInfo ?: userInfo]);
}

void RKLogRequest(NSString *where, UNNotificationRequest *req) {
  RKLogNote(where, req.identifier, req.content, nil);
}
