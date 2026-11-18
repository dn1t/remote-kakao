#import "RKHook.h"

static BOOL RKClaim(Class cls, SEL sel) {
  if (!cls || !class_getInstanceMethod(cls, sel))
    return NO;
  static NSMutableSet<NSString *> *seen;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    seen = [NSMutableSet set];
  });
  NSString *key = [NSString
      stringWithFormat:@"%s %s", class_getName(cls), sel_getName(sel)];

  @synchronized(seen) {
    if ([seen containsObject:key])
      return NO;
    [seen addObject:key];
  }

  return YES;
}

void RKHook(Class cls, SEL sel, RKBuilder make) {
  if (!RKClaim(cls, sel))
    return;
  IMP *orig = calloc(1, sizeof *orig);
  *orig =
      method_setImplementation(class_getInstanceMethod(cls, sel),
                               imp_implementationWithBlock(make(orig, sel)));
}
