#!/bin/bash
# ============================================================
#  קו שירים AI - סקריפט הפעלה למכונה של גוגל קלאוד
# ============================================================
#
#  לא צריך SSH ולא צריך טרמינל.
#  מדביקים את כל הקובץ הזה בשדה "Startup script" בטופס יצירת
#  המכונה (Advanced options -> Automation), אחרי שממלאים את
#  שלושת הערכים למטה.
#
#  המכונה מריצה את זה לבד בהפעלה. את כל הפלט רואים בקונסולה:
#  Compute Engine -> המכונה -> Serial port 1 (console)
#
# ============================================================
#  מלא כאן
# ============================================================
YEMOT_TOKEN='0779709383:48202371'
GEMINI_API_KEYS='הדבק-כאן-את-המפתח'
REPO='https://github.com/USER/kav-shirim'
EXT_PATH='8'
# ============================================================

set -u
exec > >(tee -a /var/log/kav-setup.log) 2>&1
say() { echo ""; echo "=== קו-שירים: $* ==="; }

say "מתחיל $(date)"

# הפעלה חוזרת של המכונה: אם הקו כבר רץ, לא בונים מחדש
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx kav; then
  say "הקו כבר רץ. לא משנה כלום"
  exit 0
fi

say "1/5 מתקין Docker"
export DEBIAN_FRONTEND=noninteractive
for i in 1 2 3; do
  apt-get update -qq && apt-get install -y -qq docker.io git curl && break
  echo "ניסיון $i נכשל, מנסה שוב בעוד 15 שניות"; sleep 15
done
command -v docker >/dev/null || { say "כשל: Docker לא הותקן"; exit 1; }
systemctl enable --now docker

say "2/5 קובץ החלפה"
# e2-micro הוא 1GB. ספק ה-PO Token מריץ מנוע JavaScript שלם, ובלי
# swap המכולה עלולה להיהרג בזיכרון דווקא תחת עומס.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "נוספו 2GB swap"
else
  echo "קובץ ההחלפה כבר קיים"
fi

say "3/5 מוריד את הקוד"
# בטיחות: לא מוחקים תיקיות. קיימת ואינה שלנו -> עוצרים.
if [ -d /opt/kav/.git ]; then
  HAVE=$(git -C /opt/kav remote get-url origin 2>/dev/null || echo '')
  case "$HAVE" in
    "$REPO"|"$REPO.git") echo "מעדכן"; git -C /opt/kav pull --ff-only ;;
    *) say "כשל: /opt/kav מחובר ל-$HAVE ולא ל-$REPO. לא נוגע בו"; exit 1 ;;
  esac
elif [ -e /opt/kav ]; then
  say "כשל: /opt/kav קיים ואינו ריפו גיט. לא נוגע בו"; exit 1
else
  git clone --depth 1 "$REPO" /opt/kav || { say "כשל: לא הצלחתי להוריד מ-$REPO. ודא שהריפו ציבורי"; exit 1; }
fi
[ -f /opt/kav/Dockerfile ] || { say "כשל: אין Dockerfile בשורש הריפו. הקבצים חייבים להיות בשורש, לא בתוך תיקייה"; exit 1; }

say "4/5 בונה את התמונה (כמה דקות)"
cd /opt/kav
docker build -t kav-shirim . || { say "כשל: הבנייה נכשלה"; exit 1; }

say "5/5 מפעיל"
OLD=$(docker inspect -f '{{.Config.Image}}' kav 2>/dev/null || echo '')
if [ -n "$OLD" ]; then
  case "$OLD" in
    kav-shirim*) docker rm -f kav >/dev/null ;;
    *) say "כשל: קיימת מכולה בשם kav מהתמונה $OLD ואינה שלנו"; exit 1 ;;
  esac
fi
docker run -d --name kav --restart unless-stopped \
  -p 80:3000 -p 3000:3000 \
  -e YEMOT_TOKEN="$YEMOT_TOKEN" \
  -e GEMINI_API_KEYS="$GEMINI_API_KEYS" \
  -e EXT_PATH="$EXT_PATH" \
  kav-shirim || { say "כשל: ההפעלה נכשלה"; exit 1; }

echo "ממתין שהשרת יעלה..."
for i in $(seq 1 45); do
  curl -s -o /dev/null http://127.0.0.1:3000/ && break
  sleep 2
done

IP=$(curl -s --max-time 10 https://api.ipify.org || echo '?')

say "סיימתי"
echo ""
echo "#############################################################"
echo "#  הכתובת לימות:   http://$IP/yemot"
echo "#  אבחון:          http://$IP/selftest"
echo "#  בדיקת שיר:      http://$IP/trystream?q=אדון עולם"
echo "#############################################################"
echo ""
echo "--- אבחון ---"
curl -s --max-time 60 http://127.0.0.1:3000/selftest || echo "השרת לא ענה"
echo ""
echo "--- בדיקת חילוץ אמיתית מיוטיוב ---"
curl -s --max-time 120 "http://127.0.0.1:3000/trystream?q=%D7%90%D7%93%D7%95%D7%9F%20%D7%A2%D7%95%D7%9C%D7%9D" || echo "הבדיקה לא ענתה"
echo ""
say "הכל נגמר. אם שתי הבדיקות למעלה מראות ok אמיתי, הקו מוכן"
