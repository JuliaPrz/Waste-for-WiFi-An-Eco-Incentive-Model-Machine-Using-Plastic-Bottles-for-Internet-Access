# Hardware Integration Guide (Raspberry Pi)

This guide builds on `deployment-raspberry-pi.md` and focuses specifically on wiring EcoNeT to real hardware on a Raspberry Pi.

> Prerequisite: you have already followed `deployment-raspberry-pi.md` to clone the repo, create a virtualenv, install requirements, and can access the EcoNeT portal in a browser.

---

## 1. Prepare the Raspberry Pi

1. Install Raspberry Pi OS (Lite is fine) and boot the Pi.
2. Enable:
   - SSH (via `raspi-config` → *Interface Options* → SSH).
   - Wi‑Fi interface if you will use the Pi as an access point.
3. Update the system:

   ```bash
   sudo apt update
   sudo apt upgrade -y
   ```

4. Install base dependencies (if not already done):

   ```bash
   sudo apt install -y python3 python3-venv python3-pip sqlite3 dnsmasq iptables hostapd git arp-scan
   ```

---

## 2. Get EcoNeT onto the Pi

1. Clone the repository and enter it:

   ```bash
   git clone https://github.com/JuliaPrz/Waste-for-WiFi-An-Eco-Incentive-Model-Machine-Using-Plastic-Bottles-for-Internet-Access.git
   cd Waste-for-WiFi-An-Eco-Incentive-Model-Machine-Using-Plastic-Bottles-for-Internet-Access
   ```

2. Create a virtual environment and install dependencies:

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

3. Initialize the SQLite database (optional; it will auto‑create on first run):

   ```bash
   mkdir -p instance
   python -c "from app import create_app; from db import init_db; app = create_app(); init_db(app)"
   ```

4. Run the app temporarily in development mode to verify:

   ```bash
   FLASK_APP=app.py FLASK_ENV=development flask run --host=0.0.0.0 --port=5000
   ```

5. From another device on the same LAN, visit:

   - `http://<pi-ip>:5000/`

   You should see the EcoNeT portal. At this point it still uses the mock sensor.

---

## 3. Configure the Pi as Wi‑Fi Access Point

This section turns the Pi into a hotspot so clients connect through it.

1. Configure `hostapd` for Wi‑Fi AP mode (example for `wlan0`):

   Create `/etc/hostapd/hostapd.conf`:

   ```ini
   interface=wlan0
   driver=nl80211
   ssid=EcoNeT
   hw_mode=g
   channel=6
   wmm_enabled=0
   macaddr_acl=0
   auth_algs=1
   ignore_broadcast_ssid=0
   wpa=2
   wpa_passphrase=change_this_password
   wpa_key_mgmt=WPA-PSK
   rsn_pairwise=CCMP
   ```

2. Point hostapd to this config in `/etc/default/hostapd`:

   ```bash
   DAEMON_CONF="/etc/hostapd/hostapd.conf"
   ```

3. Assign a static IP to `wlan0` (e.g., 192.168.4.1) via `/etc/dhcpcd.conf`:

   ```bash
   interface wlan0
       static ip_address=192.168.4.1/24
       nohook wpa_supplicant
   ```

4. Restart networking and enable hostapd:

   ```bash
   sudo systemctl restart dhcpcd
   sudo systemctl enable hostapd
   sudo systemctl start hostapd
   ```

---

## 4. Configure DHCP & DNS (dnsmasq)

EcoNeT reads `dnsmasq` leases to map client IP → MAC via `services/network.get_mac_for_ip`.

1. Backup the default config and create a minimal one:

   ```bash
   sudo mv /etc/dnsmasq.conf /etc/dnsmasq.conf.backup
   sudo nano /etc/dnsmasq.conf
   ```

2. Example `/etc/dnsmasq.conf`:

   ```ini
   interface=wlan0
   dhcp-range=192.168.4.10,192.168.4.100,255.255.255.0,24h

   # Lease file path should match what services/network.py expects
   dhcp-leasefile=/var/lib/misc/dnsmasq.leases

   # DNS: send all hostnames to the Pi itself
   address=/#/192.168.4.1
   ```

3. Restart dnsmasq:

   ```bash
   sudo systemctl enable dnsmasq
   sudo systemctl restart dnsmasq
   ```

4. Test MAC resolution (once a client is connected):

   ```bash
   python -c "from services.network import get_mac_for_ip; print(get_mac_for_ip('192.168.4.10'))"
   ```

   Adjust the IP to match an actual client’s lease.

---

## 5. Route Traffic and Prepare for Access Control

1. Enable IP forwarding:

   ```bash
   echo "net.ipv4.ip_forward=1" | sudo tee -a /etc/sysctl.conf
   sudo sysctl -p
   ```

2. Add basic NAT from `wlan0` to `eth0` (or your uplink):

   ```bash
   sudo iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
   sudo iptables -A FORWARD -i eth0 -o wlan0 -m state --state RELATED,ESTABLISHED -j ACCEPT
   sudo iptables -A FORWARD -i wlan0 -o eth0 -j ACCEPT
   ```

3. Persist iptables rules (e.g., using `iptables-persistent`):

   ```bash
   sudo apt install -y iptables-persistent
   sudo netfilter-persistent save
   ```

Later, access‑control logic can add/remove per‑client rules in the `FORWARD` chain based on session status.

---

## 6. Run EcoNeT in Production Mode (Gunicorn + systemd)

1. With the virtualenv active, install gunicorn if not present:

   ```bash
   pip install gunicorn
   ```

2. Test running EcoNeT on port 80 (temporarily):

   ```bash
   sudo .venv/bin/gunicorn -b 0.0.0.0:80 app:create_app()
   ```

3. Create a systemd unit `/etc/systemd/system/econet.service`:

   ```ini
   [Unit]
   Description=EcoNeT captive portal
   After=network-online.target

   [Service]
   WorkingDirectory=/opt/econet
   Environment="FLASK_APP=app.py"
   ExecStart=/opt/econet/.venv/bin/gunicorn -b 0.0.0.0:80 app:create_app()
   Restart=always
   User=www-data
   Group=www-data

   [Install]
   WantedBy=multi-user.target
   ```

   Adjust `WorkingDirectory` and paths to match where you cloned the project.

4. Enable and start the service:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable econet
   sudo systemctl start econet
   sudo systemctl status econet
   ```

5. Connect a client to the `EcoNeT` Wi‑Fi and open any HTTP site.
   You should be redirected to the EcoNeT portal.

---

## 7. Connect an IP‑Based Bottle Sensor (Prototype)

If you have an IP‑based sensor (listening on TCP, e.g. port 5000), you can test connectivity using the prototype tools in `scripts/tests`.

1. Ensure the sensor is powered and reachable from the Pi.
2. From the project root, activate the venv and run:

   ```bash
   cd scripts/tests
   python sensor_test.py --ip 192.168.1.100 --mode diag
   ```

   Replace the IP with your sensor’s IP.

3. If diagnostics pass, try monitor mode:

   ```bash
   python sensor_test.py --ip 192.168.1.100 --mode monitor
   ```

   Insert bottles and watch for detection messages.

> Note: these tests use `econet.py` and `EconetRaspberryPi` as a **standalone** prototype and are not yet wired to the Flask `/api/bottle` endpoint.

---

## 8. Wire Real Bottle Events into the Portal (TODO)

To fully connect hardware and the portal, you need a small bridge layer. Conceptually:

1. **Sensor side (hardware driver):**
   - For GPIO sensors: implement a concrete class (e.g. `GPIOSensor`) in `services/sensor.py` following the `SensorInterface` pattern.
   - For IP sensors: adapt the logic from `scripts/tests/econet.py` into a long‑running task inside the app or a sidecar service.

2. **On bottle detection:**
   - Determine the active session for that device (using IP/MAC and `db.get_session_for_device`).
   - Call the existing `/api/bottle` endpoint with `{ "session_id": ..., "count": 1 }`, **or** directly update the DB using the same logic as `/api/bottle` in `app.py`.

3. **Session state:**
   - Only accept bottles when the session status is `inserting` or `active`.
   - Reuse the time‑credit logic already implemented in `/api/bottle` and the session countdown in the frontend.

This bridging code is intentionally left flexible and will depend on your actual sensor hardware.

---

## 9. Access Control Integration (Future Work)

Currently, once a session is active, internet access is logically granted but not yet enforced at the firewall level.

A typical approach:

1. Implement an `AccessController` (e.g. in `services/session.py`) that:
   - On session activation: inserts iptables rules allowing that client IP/MAC to forward traffic to the internet.
   - On session expiry or cleanup: removes those rules.

2. Hook it into lifecycle events:
   - When `/api/session/<id>/activate` calls `db.start_session(...)`.
   - When background cleanup (in `create_app`) expires finished sessions.

3. Test by:
   - Connecting a client, verifying they cannot reach the internet before a bottle is committed.
   - Inserting a bottle and activating the session, then confirming internet access is enabled and later revoked on expiry.

---

## 10. Summary

- `deployment-raspberry-pi.md` gets the **web app** running and the Pi acting as a captive portal.
- This document adds:
  - Wi‑Fi AP + DHCP/DNS configuration.
  - IP forwarding and NAT basics.
  - How to run EcoNeT as a persistent service.
  - How to test an IP‑based sensor and where to plug real bottle events and access control into the existing codebase.

Use this guide as a checklist while wiring your specific hardware into EcoNeT.