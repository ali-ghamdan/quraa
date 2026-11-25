# قُرّاء (Quraa)

> **[English Documentation (README_EN.md)](./README_EN.md)**

مشغّل إذاعات القرآن الكريم في الطرفية وسطر الأوامر، مبني باستخدام **Bun** و **OpenTUI** (`@opentui/solid`) مع خدمة `mpv` تعمل بالخلفية عبر مأخذ Unix IPC.

## المزايا

- **فهرس إذاعات ثنائي اللغة**: يجلب الإذاعات مباشرة من `mp3quran.net/api/v3/radios` (بالعربية والإنجليزية) مع تخزين مؤقت لمدة 24 ساعة وفق معيار XDG، بالإضافة إلى قائمة احتياطية مدمجة تضم 20 إذاعة للعمل دون اتصال.
- **تشغيل مستمر بالخلفية**: يدير عملية `mpv` منفصلة تدعم إعادة الاتصال التلقائي، والإيقاف المؤقت دون تخزين مؤقت بالخلفية (zero-buffer pause)، ومؤقت نوم مدمج بلغة Lua (`assets/sleep-timer.lua`) يستمر حتى بعد إغلاق الواجهة.
- **تكامل MPRIS2 و `playerctl`**: ينشئ خدمة `org.mpris.MediaPlayer2.quraa` عبر PyGObject (`assets/mpris-bridge.py` مع بديل `/usr/lib64/mpv/mpris.so`)، ويقسّم وسوم البث المباشر (ICY) إلى `xesam:artist` (القارئ)، و `xesam:title` (السورة/الآيات)، و `xesam:album` (اسم الإذاعة)، و `mpris:artUrl` (صورة القارئ/الإذاعة).
- **ثلاثة أوضاع للعرض (`EN` / `AR` / `AR-Fixed`)**: يبدّل بين الإنجليزية والعربية المنطقية (UTF-8) ووضع `AR-Fixed` الذي يطبّق تشكيل الحروف العربية (`U+FE80–U+FEFC`) وترتيب العرض ثنائي الاتجاه (UAX #9 BiDi) للطرفيات التي لا تدعم العربية، مع معالجة تلقائية لنصوص البث التالفة الترميز (CP1256 و double-UTF-8).
- **ألوان متكيفة مع الطرفية**: يقرأ ألوان الخلفية والنص ولوحة الألوان الخاصة بطرفيتك تلقائيًا.
- **إذاعات وصور مخصصة**: يدعم إضافة روابط بث خاصة (`stations.json`) وتخصيص صور القراء والإذاعات (`images.json`).

## المتطلبات

- **Bun** بإصدار `1.3.14` أو أحدث
- **mpv**
- **دعم MPRIS2 ومفاتيح الوسائط (اختياري)**:
  - `python3` مع حزمة PyGObject (`gi.repository.Gio` / `GLib`، مثل `python3-gobject` على Fedora أو `python3-gi` على Debian/Ubuntu) لعرض بيانات القارئ والسورة وصورة الغلاف بدقة، أو
  - مكتبة `/usr/lib64/mpv/mpris.so` (`mpv-mpris`) كبديل احتياطي.
  - أداة `playerctl` للتحكم بالمشغّل وعرض البيانات من الطرفية أو اختصارات النظام.

## التثبيت

استنسخ المستودع وثبّت الاعتماديات واربط الأمر عالميًا (استبدل `<username>` باسم الحساب أو رابط المستودع):

```bash
git clone https://github.com/<username>/quraa.git
cd quraa
bun install
bun link
```

تأكّد من توفّر الأمر `quraa` في `PATH` (عادةً `~/.bun/bin/quraa`):

```bash
quraa --version
```

أو شغّل المشروع مباشرة دون ربط عالمي:

```bash
bun run start
```

## طريقة الاستخدام

### الواجهة التفاعلية (TUI)

```bash
quraa                 # تشغيل الواجهة التفاعلية
quraa --resume        # التشغيل مع استئناف آخر إذاعة تلقائيًا
quraa --no-motion     # تعطيل الحركات والتأثيرات الانتقالية
```

الضغط على `q` في وضع التصفح يفتح نافذة التأكيد **Stop Radio?** بثلاثة خيارات (`Cancel` للإلغاء، `No` للخروج مع إبقاء البث في الخلفية، `Yes` لإيقاف المشغّل والخروج). الضغط على `Q` يوقف المشغّل فورًا، بينما `Ctrl+C` يخرج من الواجهة مع استمرار البث بالخلفية.

### أوامر سطر الأوامر (CLI)

للتحكم في المشغّل أو قراءة حالته عبر السكربتات واختصارات مدير النوافذ أو شريط الحالة (مثل Waybar):

```bash
quraa play <query>          # البحث الضبابي وتشغيل الإذاعة (بالرقم أو الاسم العربي/الإنجليزي)
quraa toggle                # إيقاف مؤقت / استئناف البث، أو تشغيل آخر إذاعة محفوظة
quraa next                  # الانتقال للإذاعة التالية (ضمن المفضلة إذا كانت الحالية مفضلة)
quraa prev                  # الانتقال للإذاعة السابقة
quraa vol <0-100|+n|-n>     # ضبط مستوى الصوت أو تغييره نسبيًا (بين 0 و 100)
quraa status                # عرض حالة التشغيل الحالية نصيًا
quraa status --json         # عرض حالة التشغيل بصيغة JSON (مناسب لـ Waybar)
quraa stop                  # إيقاف عملية mpv بالخلفية
```

مثال على مخرجات `status --json`:

```json
{
  "state": "playing",
  "stationId": "79",
  "name": "Mishary Alafasi",
  "nameAr": "مشاري العفاسي",
  "trackTitle": "Al-Baqarah",
  "author": "Mishary Alafasi",
  "artUrl": "file:///.../assets/quraa-reciter.png",
  "metadata": "Mishary Alafasi - Al-Baqarah",
  "volume": 80,
  "muted": false,
  "sleepRemainingSec": 0
}
```

### التحكم عبر `playerctl`

```bash
playerctl -p quraa status
playerctl -p quraa metadata
playerctl -p quraa play-pause
playerctl -p quraa next
```

## اختصارات لوحة المفاتيح (TUI)

| المفاتيح | الوظيفة |
| --- | --- |
| `j` / `k` / `↑` / `↓` | التنقل لأعلى وأسفل |
| `g` / `G` | الانتقال إلى أول القائمة / آخرها |
| `/` (`Esc` للمسح، `↓` لإبقاء التصفية) | البحث في الإذاعات |
| `Tab` / `Shift+Tab` / `1–6` | التبديل بين التبويبات (`All`، `Favorites`، `Recent`، `Reciters`، `Theme`، `Custom`) |
| `Enter` | تشغيل الإذاعة المحددة (أو إعادة المحاولة عند الخطأ) |
| `Space` / `p` | إيقاف مؤقت أو استئناف |
| `-` / `=` أو `h` / `l` أو `←` / `→` | خفض أو رفع الصوت بمقدار `5%` |
| `m` | كتم / إلغاء كتم الصوت |
| `t` | تدوير مؤقت النوم (`Off` → `15m` → `30m` → `45m` → `60m`) |
| `f` | إضافة أو إزالة من المفضلة |
| `a` | تبديل لغة العرض (`EN` → `AR` → `AR-Fixed`) |
| `+` / `n` | إضافة إذاعة مخصصة (`http://` أو `https://`) |
| `d` / `u` | حذف الإذاعة المخصصة المحددة / التراجع خلال 6 ثوانٍ |
| `?` | عرض أو إخفاء نافذة الاختصارات |
| `q` | نافذة تأكيد الخروج (`Cancel` / `No` / `Yes`) |
| `Q` | إيقاف المشغّل والخروج فورًا |
| `Ctrl+C` | فصل الواجهة مع إبقاء الإذاعة تعمل بالخلفية |

## الإعدادات ومسارات XDG

| الغرض | المسار |
| --- | --- |
| الإذاعات المخصصة | `~/.config/quraa/stations.json` |
| إعدادات الصور المخصصة | `~/.config/quraa/images.json` |
| ذاكرة الفهرس المؤقتة (24 ساعة) | `~/.cache/quraa/stations.json` |
| الحالة المحفوظة | `~/.local/state/quraa/state.json` |
| مأخذ التحكم وملف PID | `$XDG_RUNTIME_DIR/quraa/mpv.{sock,pid}` (أو `/tmp/quraa-<uid>/mpv.{sock,pid}`) |

### تخصيص الصور (`~/.config/quraa/images.json`)

يمكنك استبدال الصور الافتراضية (`assets/quraa-reciter.png`، `assets/quraa-thematic.png`، `assets/quraa-default.png`) حسب اسم القارئ أو معرّف/اسم الإذاعة باستخدام مسار محلي (يدعم `~/`) أو رابط `file://` أو `http(s)://`:

```json
{
  "default": "~/Pictures/quraa/default.png",
  "authors": {
    "Mishary Alafasi": "~/Pictures/quraa/alafasi.jpg"
  },
  "stations": {
    "79": "~/Pictures/quraa/alafasi.jpg",
    "thematic": "https://example.com/thematic.png"
  }
}
```

ترتيب الأولوية: `authors` لدى المستخدم ← `stations` لدى المستخدم ← حقل `image` في الإذاعة المخصصة ← `assets/station-images.json` ← `default`.

### الإذاعات المخصصة (`~/.config/quraa/stations.json`)

الإذاعات المضافة عبر `+` أو `n` تُحفظ هنا، ويمكن تعديلها يدويًا لإضافة `nameAr` أو `image`:

```json
[
  {
    "id": "custom-makkah",
    "name": "Makkah Live FM",
    "nameAr": "إذاعة مكة",
    "url": "https://stream.example.com/quran.mp3",
    "image": "~/Pictures/quraa/makkah.png"
  }
]
```

## التطوير والاختبارات

```bash
bun run dev         # التشغيل مع إعادة التحميل التلقائي
bun run typecheck   # فحص الأنواع (tsc --noEmit)
bun test            # تشغيل جميع الاختبارات
```
