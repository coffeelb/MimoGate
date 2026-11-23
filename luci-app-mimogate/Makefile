# Copyright (C) 2026 COFFEELB
# SPDX-License-Identifier: MIT
#
# MimoGate - minimal LuCI app for Mihomo: service control + raw YAML config editor

include $(TOPDIR)/rules.mk

PKG_VERSION:=0.1.0
PKG_RELEASE:=25
PKG_LICENSE:=MIT AND GPL-3.0-only
PKG_PO_VERSION:=$(PKG_VERSION)-r$(PKG_RELEASE)

LUCI_TITLE:=MimoGate - minimal Mihomo service control and YAML config editor
LUCI_DEPENDS:=+luci-base +mihomo +kmod-tun +firewall4 +ca-bundle
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
