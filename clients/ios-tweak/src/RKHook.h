#pragma once
#import <Foundation/Foundation.h>
#import <objc/runtime.h>

typedef id (^RKBuilder)(IMP *orig, SEL sel);

void RKHook(Class cls, SEL sel, RKBuilder make);
