# MimoGate

**MimoGate** (`luci-app-mimogate`) is a minimal, lightweight LuCI app for [Mihomo](https://github.com/MetaCubeX/mihomo) on OpenWrt (`firewall4` / `nftables`).

Instead of bloated form-based node and rule generators, it focuses on **service control, direct raw YAML editing, and high-performance nftables transparent proxying**, offering a clean, stable, and predictable router proxy experience for users familiar with Mihomo configurations.

> [!NOTE]
> The LuCI interface design and layout take inspiration from [HomeProxy](https://github.com/immortalwrt/homeproxy) (HP). Special thanks to the HomeProxy project.

---

## Highlights & Features

- **Minimal & Non-Intrusive Raw YAML**
  - Merges your configuration via YAML anchors at startup to generate a separate runtime file (`/var/run/mimogate.yaml`), automatically injecting the TUN device, routing mark, and panel settings without modifying your saved YAML.

- **Dedicated nftables Transparent Proxy & Kernel-Level Split Routing**
  - Manages its own `table inet mimogate` firewall rules and policy routing without relying on Mihomo's `auto-route` / `auto-redirect`, keeping rules clean and predictable.
  - **Kernel-Level Mainland China IP Bypass**: Ships with a bundled mainland China IPv4/IPv6 CIDR dataset (`cn.nft`) that bypasses Mihomo directly in nftables to significantly reduce core load. Supports one-click online updates in LuCI, validated with `nft -c` before caching.
  - **Selective Port Interception**: Only intercepts common ports by default (`53, 80, 443, 853, 3478, 3479, 5222, 5349, 8443, 19302, 19305`) while bypassing all other ports, keeping bulk traffic away from the proxy core. The port list can be customized in LuCI Settings and applied via Save & Apply. When `dns.enhanced-mode: fake-ip` is configured in `config.yaml`, MimoGate automatically detects the fake-ip IPv4/IPv6 ranges and routes them to the proxy regardless of port.
  - **Smart Local & Forwarded Traffic Bypass**: Automatically bypasses private/reserved addresses and inbound port forwards (DNAT). Supports intercepting router-originated traffic while exempting DHCPv4/DHCPv6 and allowing bypass via packet mark `0x20000000` (e.g., for router-based VPN clients like WireGuard).

- **LAN Access Control (ACL) & Direct DNS Bypass**
  - Supports three modes: **All LAN devices**, **Bypass listed devices**, and **Proxy listed devices only**.
  - Matches devices by **MAC, IPv4, IPv6, or CIDR**, with a built-in online device picker (selecting MAC addresses is recommended to cover both IPv4 and IPv6).
  - For bypassed LAN devices, automatically DNATs their router-bound IPv4 DNS queries (port 53) to a direct DNS server (`223.5.5.5` by default; customizable via UCI `mimogate.config.direct_dns`) and rejects router-bound IPv6 DNS queries so dual-stack clients immediately fall back to direct IPv4 DNS without hitting Mihomo DNS (note: local `.lan` hostnames are not resolved by `dnsmasq` for bypassed devices).

- **Reliable Lifecycle Management**
  - Strictly synchronizes TUN and routing/firewall states using Mihomo's `-post-up` and `-post-down` hooks, automatically cleaning up rules on stop or unexpected exit to prevent stale routes.

- **Integrated Zashboard Web UI**
  - One-click toggle in Settings for the Mihomo External Controller API and [Zashboard](https://github.com/Zephyruso/zashboard) dashboard (disabled by default; automatically downloads the latest release assets on first use), with customizable port, secret (with reveal/hide toggle), and a quick-launch button.
  - Managed solely through the Settings page without touching `config.yaml`.

- **Clean & Intuitive LuCI Experience (Inspired by HomeProxy)**
  - Organized into three pages: **Settings** (live status bar + General / Access control tabs), **Configuration management** (raw YAML editor + validation + Load default config), and **Service status** (Baidu/Google connection check + separate auto-refreshing **MimoGate log** and **Mihomo log** viewers).
  - Supports English and Simplified Chinese (`zh_Hans`) as well as OpenWrt dark mode. All RPC methods enforce an OpenWrt `root` administrator session.

---

## Repository Structure

```text
.
├── luci-app-mimogate/   # MimoGate LuCI app (depends on luci-base, mihomo, kmod-tun, firewall4, ca-bundle)
└── mihomo-meta/         # OpenWrt package for Mihomo core (MetaCubeX/mihomo, built with with_gvisor)
```

---

## Build & Installation

Designed for OpenWrt / ImmortalWrt firmware using `firewall4` (`nftables`), recommended OpenWrt 23.05+ / 24.10+.

Clone this repository into your OpenWrt source tree under `package/` (or include it as a custom feed):

```bash
git clone https://github.com/coffeelb/mimogate.git package/mimogate
make menuconfig
```

Select the packages in `menuconfig`:
- `LuCI` -> `3. Applications` -> `luci-app-mimogate`
- `Network` -> `mihomo-meta` (optional if you already use another `mihomo` package with `-post-up` / `-post-down` support)

Compile the packages:

```bash
make package/mimogate/mihomo-meta/compile V=s
make package/mimogate/luci-app-mimogate/compile V=s
```

---

## Quick Start

1. Log in to OpenWrt LuCI and navigate to **Services -> MimoGate -> Configuration management**.
2. Click **Load default config** or paste your own Mihomo YAML configuration (must be a single YAML document with a top-level block `tun:` section and DNS listening on `127.0.0.1:1053`), update your proxy nodes, then click **Check** and **Save**.
3. Go to the **Settings** page, check **Proxy switch**, and click **Save & Apply** to start the service.
4. Use the **Service status** page to run connection checks and monitor **MimoGate log** and **Mihomo log** in real time.

---

## Technical Notes & Reserved Values

- **Core Requirement**: Requires a Mihomo binary with `-post-up` and `-post-down` support.
- **Configuration Limits**: The web editor supports single-document YAML files up to `48 KiB`. TUN route selection options in the original YAML (such as `auto-route`, `auto-redirect`, and `route-exclude-address`) do not control MimoGate's nftables rules; at runtime MimoGate manages the `mimogate0` interface directly.
- **Reserved System Values**: MimoGate uses route table and policy routing priority `10900`, packet mark bits `0x40000000` and `0x20000000`, and `firewall4`'s automatic includes. Please avoid conflicts with other custom firewall scripts.
- **Key Paths**:
  - Config files (preserved across `sysupgrade`): `/etc/config/mimogate`, `/etc/mimogate/config.yaml`
  - Mainland China IP cache: `/etc/mimogate/cn.nft` (bundled snapshot at `/usr/share/mimogate/cn.nft`)
  - Runtime logs: `/var/log/mimogate/mimogate.log`, `/var/log/mimogate/mihomo.log`

### Firewall IPv6 Behavior

MimoGate does not override `ipv6` or `dns.ipv6` in `config.yaml`. The **IPv6 support** switch in LuCI operates purely in nftables and policy routing:

| `ipv6` in `config.yaml` | LuCI **IPv6 support** | Effective Behavior |
| :---: | :---: | :--- |
| **`true`** | **Enabled** | **Full dual-stack proxy**: Both Mihomo and the firewall handle IPv6 (mainland China IPv6 still goes direct via `@cn6`). |
| **`true`** | **Disabled** | **IPv4 proxy with instant fallback**: Mihomo can still use IPv6 itself (e.g., IPv6 proxy nodes / upstream DNS); mainland China IPv6 stays direct, while proxied overseas IPv6 is rejected in the firewall so clients immediately fall back to IPv4 via the proxy. |
| **`false` (or omitted)** | **Enabled** | **`config.yaml` takes effect**: Mihomo disables IPv6 (`mimogate0` has no global IPv6 address); the firewall detects this, skips IPv6 policy routing, bypasses IPv6, and logs a reminder without breaking connectivity. |
| **`false` (or omitted)** | **Disabled** | **IPv4-only proxy**: Mihomo disables IPv6, and the firewall rejects proxied overseas IPv6 (preventing leaks or stalls even if `dns.ipv6` is still enabled) while keeping mainland China IPv6 direct. |

---

## Acknowledgments

- [HomeProxy](https://github.com/immortalwrt/homeproxy) (HP) — LuCI interface design and layout inspiration
- [MetaCubeX / mihomo](https://github.com/MetaCubeX/mihomo) — Core proxy engine
- [MetaCubeX / meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat) — Mainland China IP / domain rule datasets
- [Zephyruso / zashboard](https://github.com/Zephyruso/zashboard) — Integrated web dashboard
- [OpenWrt-nikki](https://github.com/nikkinikki-org/OpenWrt-nikki) — Reference for the `mihomo-meta` package Makefile

---

## License

- `luci-app-mimogate` is licensed under the [GNU General Public License v3.0](LICENSE) (`GPL-3.0-only`).
- The bundled `cn.nft` is generated from `MetaCubeX/meta-rules-dat` and distributed under [GPL-3.0](LICENSE).
- `mihomo-meta` is licensed under `GPL-3.0+`.
