TARGET := iphone:clang:latest:15.0
ARCHS = arm64 arm64e
INSTALL_TARGET_PROCESSES = KakaoTalk

THEOS_PACKAGE_SCHEME ?= rootless

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = RKClient

RKClient_FILES = $(wildcard src/*.x src/*.m src/*.swift)
RKClient_CFLAGS = -fobjc-arc -fvisibility=hidden -Isrc
RKClient_FRAMEWORKS = UserNotifications CryptoKit

include $(THEOS_MAKE_PATH)/tweak.mk
