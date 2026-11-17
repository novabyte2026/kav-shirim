#!/bin/bash
# הקמה אוטומטית של קו השירים על מכונה של גוגל קלאוד (או כל שרת אובונטו/דביאן).
#
# להריץ פעם אחת, מתוך ה-SSH בדפדפן של גוגל קלאוד:
#   export YEMOT_TOKEN='0771234567:הסיסמה'
#   export GEMINI_API_KEYS='AIza...'
#   export REPO='https://github.com/USER/REPO'
#   bash setup-vm.sh
#
# מה הוא עושה: מתקין Docker, מוסיף קובץ החלפה (חובה ב-1GB זיכרון),
# מוריד את הקוד, בונה את התמונה ומריץ אותה עם הפעלה-מחדש אוטומטית.
set -e

die() { echo "שגיאה: $1" >&2; exit 1; }
[ -n "$YEMOT_TOKEN" ]     || die "YEMOT_TOKEN לא הוגדר"
[ -n "$GEMINI_API_KEYS" ] || die "GEMINI_API_KEYS לא הוגדר"
[ -n "$REPO" ]            || die "REPO לא הוגדר"

echo "== 1/5 עדכון והתקנת Docker =="
sudo apt-get update -qq
sudo apt-get install -y -qq ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.asc ]; then
  sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    || sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
fi
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update -qq
sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io

echo "== 2/5 קובץ החלפה (swap) =="
# e2-micro הוא 1GB זיכרון. ספק ה-PO Token מריץ מנוע JavaScript שלם,
# ובלי swap המכולה עלולה להיהרג בזיכרון דווקא תחת עומס.
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab > /dev/null
  echo "נוספו 2GB swap"
else
  echo "קובץ ההחלפה כבר קיים"
fi

echo "== 3/5 הורדת הקוד =="
# בטיחות: לא מוחקים תיקיות. אם /opt/kav הוא כבר הריפו שלנו, מעדכנים
# אותו. אם הוא קיים ואינו הריפו שלנו, עוצרים ולא נוגעים בכלום.
if [ -d /opt/kav/.git ]; then
  HAVE=$(sudo git -C /opt/kav remote get-url origin 2>/dev/null || echo '')
  case "$HAVE" in
    "$REPO"|"$REPO.git") echo "מעדכן התקנה קיימת"; sudo git -C /opt/kav pull --ff-only ;;
    *) die "/opt/kav קיים ומחובר ל-$HAVE ולא ל-$REPO. לא נוגע בו. בחר תיקייה אחרת או מחק אותו ידנית" ;;
  esac
elif [ -e /opt/kav ]; then
  die "/opt/kav קיים ואינו ריפו גיט. לא נוגע בו"
else
  sudo git clone --depth 1 "$REPO" /opt/kav
fi
cd /opt/kav
[ -f Dockerfile ] || die "לא נמצא Dockerfile בשורש הריפו. ודא שהקבצים בשורש ולא בתוך תיקייה"

echo "== 4/5 בנייה (לוקח כמה דקות בפעם הראשונה) =="
sudo docker build -t kav-shirim .

echo "== 5/5 הפעלה =="
# בטיחות: מסירים מכולה בשם kav רק אם היא שלנו (התמונה kav-shirim).
# מכולה אחרת באותו שם נשארת, והסקריפט עוצר.
OLD=$(sudo docker inspect -f '{{.Config.Image}}' kav 2>/dev/null || echo '')
if [ -n "$OLD" ]; then
  case "$OLD" in
    kav-shirim*) sudo docker rm -f kav > /dev/null ;;
    *) die "קיימת מכולה בשם kav מהתמונה $OLD ואינה שלנו. לא נוגע בה" ;;
  esac
fi
sudo docker run -d --name kav \
  --restart unless-stopped \
  -p 80:3000 -p 3000:3000 \
  -e YEMOT_TOKEN="$YEMOT_TOKEN" \
  -e GEMINI_API_KEYS="$GEMINI_API_KEYS" \
  -e EXT_PATH="${EXT_PATH:-1}" \
  ${GREETING:+-e GREETING="$GREETING"} \
  ${SEG_SEC:+-e SEG_SEC="$SEG_SEC"} \
  ${CHAIN:+-e CHAIN="$CHAIN"} \
  ${SONG_MAX_MIN:+-e SONG_MAX_MIN="$SONG_MAX_MIN"} \
  kav-shirim

echo
echo "ממתין שהשרת יעלה..."
for i in $(seq 1 30); do
  if curl -s -o /dev/null http://127.0.0.1:3000/; then break; fi
  sleep 2
done

IP=$(curl -s --max-time 10 https://api.ipify.org || echo '?')
echo
echo "=================================================="
echo " הכתובות שלך:"
echo "   בדיקת חיים:  http://$IP/"
echo "   אבחון מלא:   http://$IP/selftest"
echo "   בדיקת שיר:   http://$IP/trystream?q=אדון+עולם"
echo "   לימות:       http://$IP/yemot"
echo "=================================================="
echo
echo "אבחון עכשיו:"
curl -s http://127.0.0.1:3000/selftest || true
echo
echo "לוג: sudo docker logs -f kav"
