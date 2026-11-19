#!/usr/bin/env python3
"""
חידוש החיבור ליוטיוב של קו השירים (העוגיות שב-COOKIES_B64 ב-Render).

למה פרופיל Firefox נפרד: גוגל "מסובבת" את עוגיות ההתחברות כל עוד הדפדפן
משתמש בהן. אם מייצאים מהפרופיל הרגיל, ברגע שגולשים שוב ביוטיוב העותק
שבשרת מת. לכן הסקריפט יוצר פרופיל ייעודי, מתחברים בו פעם אחת, והוא לא
נפתח שוב לעולם - והעוגיות נשארות תקפות לאורך זמן.

הרצה: לחיצה כפולה על "חידוש-חיבור-יוטיוב.cmd"
  - בפעם הראשונה (או כשהחיבור פג): נפתח חלון Firefox להתחברות.
    מתחברים (מומלץ חשבון גוגל משני), וכשמופיע דף טקסט פשוט - סוגרים את החלון.
  - העוגיות מועתקות ללוח (לא מוצגות על המסך), ונפתח דף ההגדרות של Render.
    שם: Edit -> בשורה COOKIES_B64 מוחקים את הערך הישן ו-Ctrl+V -> Save.

אפשרויות: --new  מוחק את הפרופיל ומתחבר מחדש (כשהחיבור פג)
          --export  רק מייצא מהפרופיל הקיים, בלי לפתוח חלון
"""

import base64
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import webbrowser

PROFILE = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "kav-shirim", "yt-profile")
FIREFOX = [
    r"C:\Program Files\Mozilla Firefox\firefox.exe",
    r"C:\Program Files (x86)\Mozilla Firefox\firefox.exe",
]
RENDER_ENV = "https://dashboard.render.com/web/srv-dbtssirm8hqs73dfbkl0/env"
# אחרי ההתחברות יוטיוב מעבירה לדף robots.txt: דף טקסט בלי סקריפטים,
# כך שהדפדפן לא מסובב את העוגיות לפני שסוגרים אותו (ההמלצה של yt-dlp).
LOGIN_URL = ("https://accounts.google.com/ServiceLogin?service=youtube&passive=true&continue="
             "https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26next%3D%252Frobots.txt")
LOGIN_NAMES = ("SID", "__Secure-1PSID", "__Secure-3PSID")


def read_cookies():
    src = os.path.join(PROFILE, "cookies.sqlite")
    if not os.path.exists(src):
        return []
    tmp = tempfile.mkdtemp()
    try:
        for suf in ("", "-wal", "-shm"):
            if os.path.exists(src + suf):
                shutil.copy2(src + suf, os.path.join(tmp, "c.sqlite" + suf))
        db = sqlite3.connect(os.path.join(tmp, "c.sqlite"))
        rows = db.execute(
            "SELECT host, path, isSecure, expiry, name, value, isHttpOnly FROM moz_cookies "
            "WHERE (host = 'youtube.com' OR host LIKE '%.youtube.com') AND originAttributes = ''"
        ).fetchall()
        db.close()
        return rows
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def netscape(rows):
    out, names, now = ["# Netscape HTTP Cookie File"], [], time.time()
    for host, path, secure, expiry, name, value, http_only in rows:
        if expiry > 10 ** 11:
            expiry //= 1000
        if expiry and expiry < now:
            continue
        out.append("\t".join([("#HttpOnly_" if http_only else "") + host,
                              "TRUE" if host.startswith(".") else "FALSE", path,
                              "TRUE" if secure else "FALSE", str(int(expiry)), name, value]))
        names.append(name)
    return "\n".join(out) + "\n", names


def login():
    ff = next((f for f in FIREFOX if os.path.exists(f)), None)
    if not ff:
        sys.exit("לא מצאתי את Firefox. צריך להתקין Firefox ואז להריץ שוב.")
    os.makedirs(PROFILE, exist_ok=True)
    print()
    print("נפתח חלון Firefox נפרד (לא הרגיל שלך).")
    print("  1. התחבר לחשבון גוגל (עדיף חשבון משני, לא הראשי).")
    print("  2. כשמופיע דף לבן עם טקסט באנגלית - סגור את החלון.")
    print("ממתין שתסגור את החלון...")
    subprocess.run([ff, "-no-remote", "-new-instance", "-profile", PROFILE, LOGIN_URL])
    time.sleep(2)


def main():
    if "--new" in sys.argv and os.path.isdir(PROFILE):
        shutil.rmtree(PROFILE, ignore_errors=True)
        print("הפרופיל הישן נמחק.")

    rows = read_cookies()
    logged = any(r[4] in LOGIN_NAMES for r in rows)
    if not logged:
        if "--export" in sys.argv:
            sys.exit("אין חיבור בפרופיל. הרץ בלי --export כדי להתחבר.")
        login()
        rows = read_cookies()
        logged = any(r[4] in LOGIN_NAMES for r in rows)
        if not logged:
            sys.exit("לא נמצאה התחברות. כנראה החלון נסגר לפני שההתחברות הסתיימה - נסה שוב.")
    else:
        print("נמצא חיבור קיים בפרופיל הייעודי (לא פותח חלון כדי לא לסובב את העוגיות).")

    text, names = netscape(rows)
    subprocess.run(["clip"], input=base64.b64encode(text.encode()), check=True)
    print()
    print("הועתק ללוח:", len(names), "עוגיות, כולל התחברות. (הערכים לא מוצגים)")
    print()
    print("עכשיו נפתח Render. שם: Edit -> בשורה COOKIES_B64 מוחקים את הישן -> Ctrl+V -> Save")
    webbrowser.open(RENDER_ENV)


if __name__ == "__main__":
    main()
