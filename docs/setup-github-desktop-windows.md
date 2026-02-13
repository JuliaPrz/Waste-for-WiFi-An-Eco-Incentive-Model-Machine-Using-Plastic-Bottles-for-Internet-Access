# Quick Guide: Use GitHub Desktop (Windows)

1) Clone the project (simple)
1. Open GitHub Desktop and sign in.
2. Go to your fork on github.com and click "Open with GitHub Desktop" OR use File → Clone repository in GitHub Desktop and pick the repo.
3. Here's the tutorial: [Fork, Clone & Edit GitHub projects easily with GitHub Desktop | 2025 Tutorial](https://www.youtube.com/watch?v=hL9fCjjwthE)

2) Create a branch
- In GitHub Desktop: Branch → New branch. Name it something like `feature/fix-typo` or your name.

3) Open the project folder and set up Python (PowerShell)
1. In GitHub Desktop: Repository → Open in Terminal (or open PowerShell in the repo folder).
2. Create and activate a virtual environment:
```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
```
3. Install required packages:
```powershell
pip install -r requirements.txt
```

3) Prepare the database
Run this once to set up the local database:
```powershell
python migrate_db.py
```

4) Run the app
```powershell
python app.py
```
Open http://localhost:5000 in the browser to check the app.



(EXTRAS - ADVANCED)
5) Save work and push (GitHub Desktop)
- Make edits in the editor.
- In GitHub Desktop: write a clear commit message and Commit to the branch.
- Click `Push origin` to upload the branch to GitHub.

6) Create a Pull Request
- In GitHub Desktop: Repository → View on GitHub. Click "Compare & pull request" to open a PR against `JuliaPrz/main`.
- In the PR message: explain what you changed and how to test it.

7) Keep the branch up-to-date
- If the main project changes, sync by fetching upstream and merging it into your branch. 