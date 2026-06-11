# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright 2023-2026 MOSSDeF, Stan Grishin (stangri@melmac.ca).

include $(TOPDIR)/rules.mk

PKG_NAME:=moci-addon-adblock-fast
PKG_VERSION:=1.2.3
PKG_RELEASE:=11

PKG_MAINTAINER:=Stan Grishin <stangri@melmac.ca>
PKG_LICENSE:=AGPL-3.0-or-later
PKG_LICENSE_FILES:=LICENSE

include $(INCLUDE_DIR)/package.mk

define Package/moci-addon-adblock-fast
  SECTION:=admin
  CATEGORY:=Administration
  SUBMENU:=MoCI Add-ons
  TITLE:=MoCI Add-on: AdBlock-Fast
  URL:=https://github.com/mossdef-org/luci-app-adblock-fast/
  PKGARCH:=all
  DEPENDS:=+moci +adblock-fast +rpcd-mod-ucode
endef

define Package/moci-addon-adblock-fast/description
  MoCI add-on providing a web UI for the adblock-fast service.
  Ships its own rpcd ucode backend (ubus object moci.adblock-fast) and an
  rpcd ACL, so it drives adblock-fast without LuCI installed. The MoCI
  equivalent of luci-app-adblock-fast.
endef

define Build/Compile
endef

define Package/moci-addon-adblock-fast/install
	$(INSTALL_DIR) $(1)/www/moci/js/addons/adblock-fast
	$(INSTALL_DATA) ./files/manifest.json $(1)/www/moci/js/addons/adblock-fast/manifest.json
	$(INSTALL_DATA) ./files/addon.js $(1)/www/moci/js/addons/adblock-fast/addon.js
	$(INSTALL_DATA) ./files/style.css $(1)/www/moci/js/addons/adblock-fast/style.css

	$(INSTALL_DIR) $(1)/usr/share/rpcd/ucode
	$(INSTALL_DATA) ./files/moci.adblock-fast $(1)/usr/share/rpcd/ucode/moci.adblock-fast

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./files/acl.json $(1)/usr/share/rpcd/acl.d/moci-addon-adblock-fast.json
endef

define Package/moci-addon-adblock-fast/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/rpcd reload 2>/dev/null
exit 0
endef

define Package/moci-addon-adblock-fast/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/rpcd reload 2>/dev/null
exit 0
endef

$(eval $(call BuildPackage,moci-addon-adblock-fast))
