import sqlite3
import os

# Path to your SQLite database
DB_PATH = os.path.join("instance", "wifi_portal.db")

# Connect to the database
conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

# List of tables to clear
tables = ["sessions", "ratings", "system_logs"]

for table in tables:
    cursor.execute(f"DELETE FROM {table}")
    print(f"Cleared table: {table}")

# Commit deletions BEFORE vacuum
conn.commit()
print("Deletions committed.")

# Now safely run VACUUM
cursor.execute("VACUUM;")
print("Database vacuumed (space reclaimed).")

# Close connection
conn.close()
print("All data cleared. Schema remains intact.")
