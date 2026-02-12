"""
Simulates a bottle sensor for testing.
Sends bottle detection events to the API.
"""
import requests
import time
import sys

def simulate_bottle(session_id, num_bottles=3, delay=2):
    """Simulate bottle insertions."""
    print(f"\n=== Simulating {num_bottles} bottle insertions ===\n")
    
    for i in range(num_bottles):
        print(f"Inserting bottle {i+1}...")
        
        response = requests.post(
            'http://localhost:5000/api/bottle',
            json={'session_id': session_id}
        )
        
        if response.ok:
            data = response.json()
            print(f"  ✓ Success! Total bottles: {data['bottles_inserted']}, Time earned: {data['minutes_earned']} min")
        else:
            print(f"  ✗ Failed: {response.text}")
        
        if i < num_bottles - 1:
            time.sleep(delay)
    
    print("\n=== Simulation complete ===\n")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python scripts/simulate_sensor.py <session_id> [num_bottles] [delay_seconds]")
        sys.exit(1)
    
    session_id = int(sys.argv[1])
    num_bottles = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    delay = float(sys.argv[3]) if len(sys.argv) > 3 else 2
    
    simulate_bottle(session_id, num_bottles, delay)