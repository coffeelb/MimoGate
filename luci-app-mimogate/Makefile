# Copyright (C) 2026 COFFEELB
# SPDX-License-Identifier: GPL-3.0-only
#
# MimoGate - minimal LuCI app for Mihomo: service control + raw YAML config editor

include $(TOPDIR)/rules.mk

PKG_VERSION:=0.1.1
PKG_RELEASE:=23
PKG_LICENSE:=GPL-3.0-only
PKG_LICENSE_FILES:=LICENSE
PKG_PO_VERSION:=$(PKG_VERSION)-r$(PKG_RELEASE)

LUCI_TITLE:=MimoGate - minimal Mihomo service control and YAML config editor
LUCI_DEPENDS:=+luci-base +mihomo +kmod-tun +firewall4 +ca-bundle
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

define Package/luci-app-mimogate/conffiles
/etc/config/mimogate
/etc/mimogate/
endef

# call BuildPackage - OpenWrt buildroot signature
