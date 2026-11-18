TARGET := iphone:clang:latest:15.0
ARCHS = arm64 arm64e
INSTALL_TARGET_PROCESSES = KakaoTalk

THEOS_PACKAGE_SCHEME ?= rootless

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = RKClient

RKClient_FILES = Tweak.x
RKClient_CFLAGS = -fobjc-arc
RKClient_FRAMEWORKS = UIKit

include $(THEOS_MAKE_PATH)/tweak.mk
