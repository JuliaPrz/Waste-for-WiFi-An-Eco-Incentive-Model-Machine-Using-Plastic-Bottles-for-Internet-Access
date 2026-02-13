# Deployment on Raspberry Pi

This guide summarizes what you need to run EcoNeT as a captive portal on a Raspberry Pi.

## 1. Basic Application Setup

1. Install dependencies (Raspberry Pi OS example):

   ```bash
   sudo apt update
   sudo apt install -y python3 python3-venv python3-pip sqlite3 dnsmasq iptables
   ```

2. Clone the repository:

   ```bash
   git clone https://github.com/JuliaPrz/Waste-for-WiFi-An-Eco-Incentive-Model-Machine-Using-Plastic-Bottles-for-Internet-Access.git
   cd Waste-for-WiFi-An-Eco-Incentive-Model-Machine-Using-Plastic-Bottles-for-Internet-Access
   ```

3. Create a virtual environment and install Python deps:

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt  # or install flask, gunicorn, etc.
   ```

4. Initialize the database (optional; auto‑created on first run):

   ```bash
   mkdir -p instance
   python -c "from app import create_app; from db import init_db; app = create_app(); init_db(app)"
   ```

5. Run the app (development):

   ```bash
   FLASK_APP=app.py FLASK_ENV=development flask run --host=0.0.0.0 --port=5000
   ```

   For production, use `gunicorn` or similar on port 80 or behind a reverse proxy.

## 2. Captive Portal & Networking

Goal: all HTTP traffic from Wi‑Fi clients should be redirected to the Flask app, and the app must see the real client IP.

Typical stack:

1. Configure the Pi as Wi‑Fi AP + DHCP/DNS using `hostapd` + `dnsmasq`:
   - `dnsmasq`:
     - Serves DHCP leases.
     - Answers DNS, typically pointing all hostnames to the Pi’s IP.

2. Ensure `dnsmasq` writes leases where EcoNeT can read them:
   - `/var/lib/misc/dnsmasq.leases` or
   - `/var/lib/dnsmasq/dnsmasq.leases`.

   EcoNeT uses `services.network.get_mac_for_ip` to resolve IP → MAC.

3. HTTP redirection:
   - Option 1 – Flask/gunicorn on port 80:
     - Bind directly to `0.0.0.0:80`.
   - Option 2 – Reverse proxy (Nginx/Apache):
     - Forward all HTTP to the Flask app.
     - Pass `X-Forwarded-For` so Flask can read the real client IP.

4. NAT / firewall:
   - Use `iptables` (or `nftables`) to:
     - NAT traffic from Wi‑Fi interface to upstream (Ethernet/WWAN).
     - Optionally restrict outbound access until session is active (future integration).

## 3. MAC Address Resolution

`services/network.get_mac_for_ip(ip)` tries:

1. `dnsmasq` lease files.
2. `/proc/net/arp`.
3. `arp -n` / `arp -a` via subprocess.

Checklist:

- Confirm `dnsmasq` lease file path matches the paths in `network.py`.
- Ensure `arp` is installed and accessible.

Quick test on the Pi:

```bash
python -c "from services.network import get_mac_for_ip; print(get_mac_for_ip('192.168.4.2'))"
```

Replace `192.168.4.2` with the IP of a connected client.

## 4. Systemd Service (Production)

Example unit file `/etc/systemd/system/econet.service`:

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

Activate:

```bash
sudo systemctl daemon-reload
sudo systemctl enable econet
sudo systemctl start econet
```

Adjust paths, user/group, and command for your environment.

## 5. Open TODOs for Pi

- Implement real GPIO‑based bottle sensor in `services/sensor.py`.
- Implement access control (iptables/VLAN) based on session status in `services/session.py` or a new module.
- Harden network stack and firewall rules according to your deployment needs.