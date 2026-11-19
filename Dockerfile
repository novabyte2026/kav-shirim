# מכולה אחת שמכילה הכול: השרת, yt-dlp, ffmpeg וספק ה-PO Token.
#
# למה ספק PO Token: בלעדיו יוטיוב מחזיר "Sign in to confirm you're not a bot"
# לכל בקשה שמגיעה מ-IP של דאטה-סנטר (כל שרת בענן). עם הספק הזה החילוץ
# עובד בלי עוגיות ובלי פרוקסי. הנוסחה הזאת מאומתת בייצור.

# לוקחים מהתמונה של bgutil רק את /app (הקוד המקומפל + node_modules).
# היא בנויה על node:26-bookworm-slim, ולכן גם שלנו - כדי שהמודול הבינארי
# canvas שבתוכה יתאים ל-Node שמריץ אותו.
FROM brainicism/bgutil-ytdlp-pot-provider:2.0.0-node AS pot

FROM node:26-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      ca-certificates \
      curl \
      unzip \
 && rm -rf /var/lib/apt/lists/* \
 # קישור סימבולי: בזמן ריצה ה-PATH לפעמים מצומצם ו-ffmpeg לא נמצא
 && ln -sf /usr/bin/ffmpeg /usr/local/bin/ffmpeg \
 && ln -sf /usr/bin/ffprobe /usr/local/bin/ffprobe \
 && ffmpeg -version | head -1

# Deno: מנוע JavaScript. yt-dlp חייב אותו כדי לפתור את אתגרי החתימה
# של יוטיוב (signature / n challenge). בלעדיו כל הפורמטים נחסמים
# והשגיאה היא "The page needs to be reloaded".
ADD https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip /tmp/deno.zip
RUN unzip -o /tmp/deno.zip -d /usr/local/bin \
 && chmod 755 /usr/local/bin/deno \
 && rm -f /tmp/deno.zip \
 && deno --version

# ADD עם כתובת נבדק מחדש בכל בנייה, ולכן גרסה חדשה של yt-dlp נמשכת לבד.
# ה-nightly ולא ה-stable: תיקונים לשינויים של יוטיוב מגיעים לשם קודם.
ADD https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp /usr/local/bin/yt-dlp
ADD https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/2.0.0/bgutil-ytdlp-pot-provider.zip /etc/yt-dlp/plugins/bgutil-ytdlp-pot-provider.zip

RUN chmod 755 /usr/local/bin/yt-dlp \
 && chmod 644 /etc/yt-dlp/plugins/bgutil-ytdlp-pot-provider.zip \
 && yt-dlp --version

COPY --from=pot /app /opt/bgutil
RUN test -f /opt/bgutil/build/main.js

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY start.sh ./
RUN chmod 755 start.sh

# נתיבים מוחלטים, כדי ש-spawn לא יהיה תלוי ב-PATH של זמן הריצה
ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/local/bin/ffmpeg \
    YTDLP_PATH=/usr/local/bin/yt-dlp \
    POT_BASE_URL=http://127.0.0.1:4416 \
    PORT=3000 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

EXPOSE 3000
CMD ["./start.sh"]
