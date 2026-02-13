# Raspberry Pi Networking & Hardware Concepts for EcoNeT

This document explains the core pieces you see mentioned in the EcoNeT docs (iptables, dnsmasq, hostapd, GPIO pins, TCP/IP devices, etc.) in beginner‑friendly language.

It is **not** code; it’s mental models so you can understand what the deployment guides are doing.

---

## 1. Captive Portal: the Big Picture

A **captive portal** is the “Wi‑Fi login page” you see in airports or cafes.

For EcoNeT on a Raspberry Pi:

- The Pi acts as a **Wi‑Fi hotspot**.
- When a phone connects and tries to open any website, traffic is **redirected** to the EcoNeT Flask app.
- EcoNeT:
  - Identifies the device (IP + MAC or a cookie).
  - Creates a **session** in the SQLite database.
  - Grants or denies internet access based on bottles inserted.

To make this work, several Linux tools cooperate: `hostapd`, `dnsmasq`, `iptables`, and your Flask app.

---

## 2. Basic Networking Terms

### IP Address

- A numeric label for a device on a network, like `192.168.4.10`.
- Every phone/laptop connected to the Pi’s Wi‑Fi gets an IP.

### MAC Address

- A hardware address for a network interface, like `aa:bb:cc:dd:ee:ff`.
- Stays the same even if the IP changes.
- EcoNeT uses the MAC (or a cookie) as the **device identifier** so it can find that device’s session reliably.

### ARP and `/proc/net/arp`

- **ARP** (Address Resolution Protocol) maps IP addresses ↔ MAC addresses on a local network.
- On Linux, the current ARP table is at `/proc/net/arp`.
- EcoNeT’s [services/network.py](services/network.py) reads this file (and `dnsmasq` leases) to turn a client IP into a MAC.

---

## 3. hostapd – Turning the Pi Into a Wi‑Fi Hotspot

- `hostapd` = **Host Access Point Daemon**.
- It makes your Pi’s Wi‑Fi interface (e.g. `wlan0`) behave like a router’s Wi‑Fi.
- You define:
  - SSID (network name), e.g. `EcoNeT`.
  - Channel, Wi‑Fi mode, and password.

In EcoNeT’s guides:

- You create `/etc/hostapd/hostapd.conf` to set up the SSID.
- You assign a **static IP** to `wlan0` (e.g. `192.168.4.1`), which becomes the “gateway” for clients.

Without `hostapd`, the Pi is just a client on another Wi‑Fi; with it, the Pi **hosts** its own Wi‑Fi network.

---

## 4. dnsmasq – Giving Clients IPs and Capturing Hostnames

`dnsmasq` is a small **DHCP + DNS server**.

- **DHCP**: hands out IP addresses to devices (e.g. `192.168.4.10`, `.11`, `.12`, …).
- **DNS**: translates hostnames (like `example.com`) into IPs.

In EcoNeT’s setup:

- `dnsmasq` listens on `wlan0` and:
  - Gives each new client an IP in a chosen range.
  - Writes a **lease file** (e.g. `/var/lib/misc/dnsmasq.leases`) that records: IP, MAC, and hostname.
- `services/network.get_mac_for_ip(ip)` looks at this lease file to map a client’s IP → MAC.

This mapping is key for:

- Correctly identifying the same device over time.
- Enforcing access control by IP or MAC in `iptables`.

---

## 5. iptables – Controlling Who Can Reach the Internet

`iptables` is the classic Linux **firewall** tool.

It can:

- Allow or block packets based on:
  - Source/destination IP.
  - Network interface (e.g. `wlan0` vs `eth0`).
  - Protocol (TCP/UDP) and port (80, 443, etc.).
- Perform **NAT** (Network Address Translation), which lets multiple devices share one external IP.

In the EcoNeT context:

- You use `iptables` to:
  1. Enable NAT so client traffic from `wlan0` can go out through `eth0` (or another uplink).
  2. Optionally, add per‑client rules so **only devices with an active EcoNeT session** can reach the wider internet.

Typical rules from the docs:

- MASQUERADE (NAT):
  - `iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE`
- Forward rules to let packets go from Wi‑Fi to Ethernet:
  - `iptables -A FORWARD -i eth0 -o wlan0 -m state --state RELATED,ESTABLISHED -j ACCEPT`
  - `iptables -A FORWARD -i wlan0 -o eth0 -j ACCEPT`

Access control (future work) would mean:

- Adding rules that only allow traffic from specific IPs/MACs when their session is `active`.
- Removing those rules when the session expires.

---

## 6. Flask App, Sessions, and the Database

Your Python code ties into this network plumbing as follows:

- [app.py](app.py):
  - Creates the Flask app and loads config like `MOCK_SENSOR`, `SESSION_DURATION`, and DB path.
  - Registers routes for:
    - Session lifecycle (`/api/session/*`).
    - Bottle events (`/api/bottle`).
    - Rating (`/rating`, `/api/rating`, `/api/rating/status`).
    - Admin metrics and WebSocket for the admin dashboard.
- [db.py](db.py):
  - Defines the SQLite schema (sessions, ratings, bottle logs, system logs).
  - Stores how many bottles a device has inserted and how many seconds of internet they earned.
- [routes/portal.py](routes/portal.py):
  - Helps identify devices by MAC or cookie.
  - Implements `/api/session/lookup`, which finds or creates a session for the current device.
- [static/js](static/js):
  - Runs in the browser, calling `/api/session/*` and `/api/bottle` to track state, timers, and UI.

The **firewall** (`iptables`) and **captive redirect** (via special URLs like `/generate_204`) are what connect this Flask logic to real network traffic.

---

## 7. GPIO Pins – Direct Hardware Connections

**GPIO** (General Purpose Input/Output) pins are the physical pins on the Raspberry Pi header.

- You can connect simple electronics to them: switches, LEDs, sensors.
- For a bottle sensor, common patterns are:
  - An IR break‑beam sensor.
  - An ultrasonic sensor.
  - A mechanical switch triggered by the bottle.

Software side:

- Libraries: `RPi.GPIO`, `gpiozero`, or newer `libgpiod` bindings.
- The idea: write a class (e.g. `GPIOSensor`) that:
  - Configures a GPIO pin as input.
  - Registers a callback for when the pin changes state.
  - On each “bottle detected” event, calls into the EcoNeT backend (e.g. `/api/bottle`).

EcoNeT’s [services/sensor.py](services/sensor.py) currently has:

- `SensorInterface`: base class.
- `MockSensor`: lets you trigger bottles via dev tools.

To support real GPIO hardware, you would add something like:

- `class GPIOSensor(SensorInterface):` that actually talks to the pins.

---

## 8. TCP/IP Devices – Network‑Attached Sensors

Not all sensors connect via GPIO. Some are **network devices** reachable over TCP/IP.

- Example: an external controller with its own microcontroller and Ethernet/Wi‑Fi.
- It might expose a simple ASCII protocol over a TCP socket (e.g. port 5000).

In your repo:

- [scripts/tests/econet.py](scripts/tests/econet.py) shows a prototype client:
  - `IPSensorClient` connects to a sensor IP/port with `socket`.
  - It sends commands like `STATUS`, `DETECT`, `MEASURE`, `GET_VOLUME`.
  - It parses responses and tracks volume per bottle.

If you choose an IP‑based sensor for production, you’d:

- Adapt that prototype into a long‑running process or background thread in the Flask app.
- On detection events, call `/api/bottle` with the correct `session_id` and `count`.

This is an alternative to GPIO – still hardware, just connected over the network instead of pins.

---

## 9. MOCK_SENSOR and the Mock Dev Panel

To make development easy without any hardware:

- The app uses a **mock sensor** (`MockSensor`) and a **Mock Dev Panel** in the UI.
- `MOCK_SENSOR` config:
  - In [app.py](app.py), `MOCK_SENSOR` comes from an environment variable.
  - When `true`, you use dev tools to simulate bottles via the web UI.
- Dev panel:
  - [templates/partials/mock_dev_panel.html](templates/partials/mock_dev_panel.html) + [static/js/mockDevPanel.js](static/js/mockDevPanel.js).
  - Buttons to simulate bottle inserts and session start/stop.

On a real Raspberry Pi with real hardware:

- You’d set `MOCK_SENSOR=false` in the environment and wire in a real sensor implementation.

---

## 10. Putting It All Together (High‑Level Flow)

1. **Wi‑Fi AP**: hostapd makes the Pi broadcast `EcoNeT` SSID.
2. **DHCP/DNS**: dnsmasq gives clients IP addresses and logs leases.
3. **Firewall & NAT**: iptables forwards traffic and (optionally) restricts it.
4. **Captive Detection**: clients hit `/generate_204` or similar; EcoNeT redirects them to `/`.
5. **Device Identification**: EcoNeT uses `services/network.get_mac_for_ip` and cookies to track devices.
6. **Sessions & Bottles**:
   - Frontend calls `/api/session/lookup` to create/find a session.
   - Sensor (mock or real) triggers `/api/bottle` when bottles are inserted.
   - DB tracks bottles and computes `session_end` time.
7. **Internet Access** (future enhancement): access controller adjusts iptables rules when sessions become `active` or `expired`.

---

## 11. What You Actually Need to Learn First

If you’re new to all this, focus on these in order:

1. **Basic Linux networking on Raspberry Pi**
   - IP addresses, interfaces (`wlan0`, `eth0`).
   - How to edit `/etc/dhcpcd.conf` and `/etc/systemd/system/*.service`.

2. **hostapd + dnsmasq basics**
   - How to configure Wi‑Fi AP and DHCP range.
   - Where dnsmasq writes its leases, and how EcoNeT reads them.

3. **Basic iptables usage**
   - Enabling NAT so your Pi can share its internet.
   - Optionally, how to add/remove simple rules for one IP.

4. **Sensor type decision**
   - Will your real machine use **GPIO** (direct pin) or **TCP/IP sensor**?
   - Once you decide, you can focus only on that part of the stack.

After you’re comfortable with these concepts, the code in this repo and the deployment guides will feel much more intuitive, and you’ll be ready to implement a real sensor and (optionally) per‑session access control.
