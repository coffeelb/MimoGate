minimal LuCI app for Mihomo: service control + raw YAML config editor

## Firewall and TUN

MimoGate uses its own nftables table and policy routes. Use Mihomo with
`-post-up` and `-post-down` support and a single YAML document with a
top-level block `tun:` section. The app keeps the saved YAML and generates
a runtime copy with interface `mimogate0`, auto-route and auto-redirect
disabled, and a mark for Mihomo's outbound sockets.

The `proxy-ports` list selects LAN TCP/UDP ports. Router-originated TCP/UDP
is also eligible for interception (DHCPv4/DHCPv6 client traffic is exempted;
router-originated VPN clients such as WireGuard can set packet mark
`0x20000000` to bypass MimoGate). Private and local destinations, inbound
port forwards, and mainland China destinations are bypassed. The app uses
route table and priority 10900, packet mark bits `0x40000000` and
`0x20000000`, and firewall4's automatic includes. Reserve these values
for MimoGate. The original YAML's TUN route selection options do not
control this firewall.

MimoGate loads a cached mainland China IPv4/IPv6 list when present, or
falls back to the bundled snapshot. Manual updates in LuCI validate and
save the new list to cache so it takes effect on the next restart.

The unmodified cn.list comes from MetaCubeX/meta-rules-dat at
https://github.com/MetaCubeX/meta-rules-dat/blob/ca7d9d641cf31a25d465861d8af0352e6721b6e0/geo/geoip/cn.list
and is distributed under GPL-3.0 with LICENSE.cn-list.
