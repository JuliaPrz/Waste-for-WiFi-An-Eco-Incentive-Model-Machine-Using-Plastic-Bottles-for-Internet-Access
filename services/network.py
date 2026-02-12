"""Network utilities: methods to resolve IP -> MAC using dnsmasq leases, ARP, or arp tool.

This helps the captive portal determine client MAC addresses from the Pi host.
"""
import os
import re
import subprocess
from typing import Optional


def _read_dnsmasq_leases(paths=None):
    # Common dnsmasq lease locations
    if paths is None:
        paths = ["/var/lib/misc/dnsmasq.leases", "/var/lib/dnsmasq/dnsmasq.leases"]
    for p in paths:
        if os.path.exists(p):
            try:
                with open(p, "r") as fh:
                    for line in fh:
                        parts = line.strip().split()
                        if len(parts) >= 3:
                            yield {"expiry": parts[0], "mac": parts[1], "ip": parts[2], "host": parts[3] if len(parts) > 3 else None}
            except Exception:
                continue


def get_mac_from_dnsmasq(ip: str) -> Optional[str]:
    for rec in _read_dnsmasq_leases():
        if rec.get("ip") == ip:
            mac = rec.get("mac")
            if mac and mac != "00:00:00:00:00:00":
                return mac
    return None


def get_mac_from_proc_arp(ip: str) -> Optional[str]:
    p = "/proc/net/arp"
    if os.path.exists(p):
        try:
            with open(p, "r") as fh:
                for line in fh.readlines()[1:]:
                    parts = line.split()
                    if parts and parts[0] == ip:
                        mac = parts[3]
                        if mac and mac != "00:00:00:00:00:00":
                            return mac
        except Exception:
            pass
    return None


def get_mac_from_arp_cmd(ip: str) -> Optional[str]:
    for cmd in (["arp", "-n", ip], ["arp", "-a", ip]):
        try:
            out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, universal_newlines=True)
            m = re.search(r"([0-9a-fA-F]{2}(?:[:\-][0-9a-fA-F]{2}){5})", out)
            if m:
                return m.group(1)
        except Exception:
            continue
    return None


def get_mac_for_ip(ip: str) -> Optional[str]:
    """
    Resolve a client MAC for a given IPv4 address.
    Attempts, in order:
      - dnsmasq leases (if Pi uses dnsmasq)
      - /proc/net/arp (Linux ARP table)
      - arp command output (fallback)
    Returns MAC string like 'aa:bb:cc:dd:ee:ff' or None.
    """
    # 1) dnsmasq leases
    try:
        for rec in _read_dnsmasq_leases():
            if rec.get("ip") == ip:
                mac = rec.get("mac")
                if mac and mac != "00:00:00:00:00:00":
                    return mac.lower()
    except Exception:
        pass

    # 2) /proc/net/arp
    try:
        p = "/proc/net/arp"
        if os.path.exists(p):
            with open(p, "r") as fh:
                lines = fh.read().strip().splitlines()
                for line in lines[1:]:
                    parts = line.split()
                    if parts and parts[0] == ip:
                        mac = parts[3]
                        if mac and mac != "00:00:00:00:00:00":
                            return mac.lower()
    except Exception:
        pass

    # 3) arp command fallback
    for cmd in (["arp", "-n", ip], ["arp", "-a", ip]):
        try:
            out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, universal_newlines=True)
            m = re.search(r"([0-9a-fA-F]{2}(?:[:\-][0-9a-fA-F]{2}){5})", out)
            if m:
                return m.group(1).lower()
        except Exception:
            continue

    return None
