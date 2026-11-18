#import "RKExtension.h"
#import "RKLog.h"
#import <Foundation/Foundation.h>

%ctor {
  RKLog([NSString stringWithFormat:@"loaded into %@",
                                   NSBundle.mainBundle.bundleIdentifier]);
  RKHookExtension();
}
