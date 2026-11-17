#!/usr/bin/env python3
"""
רענון וייצוא של עוגיות יוטיוב ללוח, בשביל COOKIES_B64 ב-Render.

מבוסס על tools/cookie-sync/refresh_cookies.py מהפרויקט הקודם, אבל במקום
לדחוף לסוד ב-GitHub הוא מעתיק ללוח כדי שתדביק ב-Render.

למה צריך רענון ולא רק ייצוא: יוטיוב מסובבת את עוגיות הסשן. מה שיושב
ב-cookies.sqlite יכול להיות כבר מיושן. טעינת youtube.com ב-Firefox נסתר
גורמת ליוטיוב להגיש עוגיות טריות, והן נכתבות לקובץ. רק אז מייצאים.

חשוב: צריך לסגור את Firefox לפני ההרצה, אחרת הפרופיל נעול והרענון ייכשל.

הרצה:  py refresh-cookies.py
"""

import base64
import glob
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time

FIREFOX_PATHS = [
    r"C:\Program Files\Mozilla Firefox\firefox.exe",
    r"C:\Program Files (x86)\Mozilla Firefox\firefox.exe",
]
SESSION_COOKIES = ("SID", "__Secure-3PSID", "__Secure-1PSID")
REFRESH_TIMEOUT = 120


def read_cookies(profile_dir):
    """קורא את עוגיות יוטיוב מ-cookies.sqlite של הפרופיל (עותק, כדי לא לנעול)."""
    src = os.path.join(profile_dir, "cookies.sqlite")
    if not os.path.exists(src):
        return []
    tmp = tempfile.mkdtemp()
    try:
        for suffix in ("", "-wal", "-shm"):
            if os.path.exists(src + suffix):
                shutil.copy2(src + suffix, os.path.join(tmp, "cookies.sqlite" + suffix))
        db = sqlite3.connect(os.path.join(tmp, "cookies.sqlite"))
        rows = db.execute(
            "SELECT host, path, isSecure, expiry, name, value, isHttpOnly FROM moz_cookies "
            "WHERE (host = 'youtube.com' OR host LIKE '%.youtube.com') AND originAttributes = ''"
        ).fetchall()
        db.close()
        return rows
    except Exception as e:
        print("  שגיאה בקריאת העוגיות:", e)
        return []
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def to_netscape(rows):
    """בונה טקסט Netscape ומחזיר גם את רשימת השמות (בלי ערכים)."""
    lines = ["# Netscape HTTP Cookie File"]
    names = []
    now = time.time()
    for host, path, secure, expiry, name, value, http_only in rows:
        if expiry > 10 ** 11:
            expiry //= 1000
        if expiry and expiry < now:
            continue
        domain = ("#HttpOnly_" if http_only else "") + host
        lines.append("\t".join([
            domain,
            "TRUE" if host.startswith(".") else "FALSE",
            path,
            "TRUE" if secure else "FALSE",
            str(int(expiry)),
            name,
            value,
        ]))
        names.append(name)
    return "\n".join(lines) + "\n", names


def main():
    profiles = glob.glob(os.path.expandvars(r"%APPDATA%\Mozilla\Firefox\Profiles\*"))
    profiles = [p for p in profiles if os.path.exists(os.path.join(p, "cookies.sqlite"))]
    if not profiles:
        sys.exit("לא נמצא פרופיל Firefox עם cookies.sqlite")

    # בוחרים את הפרופיל שבו יש עוגיית התחברות ליוטיוב
    chosen = None
    for p in sorted(profiles, key=os.path.getmtime, reverse=True):
        names = [r[4] for r in read_cookies(p)]
        if any(n in names for n in SESSION_COOKIES):
            chosen = p
            break
    if not chosen:
        sys.exit("לא נמצא פרופיל עם חשבון יוטיוב מחובר. התחבר ליוטיוב ב-Firefox ונסה שוב")

    print("פרופיל:", os.path.basename(chosen))

    # --- שלב 1: רענון. בלעדיו מייצאים עוגיות שיוטיוב כבר סובבה ---
    firefox = next((f for f in FIREFOX_PATHS if os.path.exists(f)), None)
    if not firefox:
        print("  Firefox לא נמצא; מדלג על רענון (העוגיות עלולות להיות מיושנות)")
    else:
        shot = os.path.join(tempfile.gettempdir(), "yt-refresh.png")
        try:
            print("  מרענן מול יוטיוב (עד 2 דקות)...")
            subprocess.run(
                [firefox, "-headless", "--profile", chosen, "--screenshot", shot,
                 "https://www.youtube.com/"],
                timeout=REFRESH_TIMEOUT,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            print("  רענון הושלם")
        except subprocess.TimeoutExpired:
            print("  !! הרענון נתקע. כנראה Firefox פתוח - סגור אותו לגמרי ונסה שוב.")
            print("     (ממשיך לייצוא, אבל העוגיות עלולות להיות מיושנות)")
        except Exception as e:
            print("  !! הרענון נכשל:", e)
        finally:
            try:
                os.remove(shot)
            except Exception:
                pass

    # --- שלב 2: ייצוא ---
    rows = read_cookies(chosen)
    text, names = to_netscape(rows)
    logged_in = any(n in names for n in SESSION_COOKIES)

    if not logged_in:
        sys.exit("!! אין עוגיית התחברות (SID). לא מעתיק ללוח כדי לא לדרוס ערך תקין.")

    # --- שלב 3: ללוח. הערך לא מודפס למסך לעולם ---
    subprocess.run(["clip"], input=base64.b64encode(text.encode()), check=True)

    print("עוגיות יוטיוב:", len(names), " מחובר:", logged_in,
          " LOGIN_INFO:", "LOGIN_INFO" in names)
    print("שמות:", ",".join(sorted(set(names))))
    print()
    print("הועתק ללוח. עכשיו: Render -> kav-shirim -> Environment -> COOKIES_B64 -> Ctrl+V -> Save")


if __name__ == "__main__":
    main()
