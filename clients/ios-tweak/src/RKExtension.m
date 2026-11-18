#import "RKExtension.h"
#import "RKHook.h"
#import "RKLog.h"
#import <UserNotifications/UserNotifications.h>

// we don't know the name of the subclass,
// so we have to find it by walking the class list
void RKHookExtension(void) {
  Class base = objc_getClass("UNNotificationServiceExtension");
  if (!base)
    return;

  unsigned int n = 0;
  Class *all = objc_copyClassList(&n);

  for (unsigned int i = 0; i < n; i++) {
    for (Class c = class_getSuperclass(all[i]); c; c = class_getSuperclass(c)) {
      if (c != base)
        continue;

      RKHook(all[i],
             @selector(didReceiveNotificationRequest:withContentHandler:),
             ^id(IMP *orig, SEL sel) {
               return ^(id self, UNNotificationRequest *req,
                        void (^done)(UNNotificationContent *)) {
                 RKLogRequest(@"NSE", req);
               };
             });

      break;
    }
  }
  free(all);
}
