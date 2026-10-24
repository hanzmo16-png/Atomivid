"""Lectura de fuentes para ZEITGEIST (USD 0, solo GET, sin secretos).

Descarga cada fuente, la convierte a texto y escribe en el log los pasajes alrededor de las palabras clave,
para verificar los datos [PENDIENTE] del guion y las tarifas públicas de proveedores.
"""
import html, json, re, subprocess, sys, urllib.request

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"

SOURCES = [
    # (id, url, palabras clave)
    ("boe", "https://www.bankofengland.co.uk/-/media/boe/files/quarterly-bulletin/2014/money-creation-in-the-modern-economy.pdf",
     ["create money", "new deposit", "money multiplier", "limits", "Michael McLeay"]),
    ("nsa-hanyok", "https://www.nsa.gov/portals/75/documents/news-features/declassified-documents/gulf-of-tonkin/articles/release-1/rel1_skunks_bogies.pdf",
     ["no attack", "did not happen", "never happened", "Herrick", "doubtful"]),
    ("nsarchive", "https://nsarchive2.gwu.edu/NSAEBB/NSAEBB132/press20051201.htm", ["second attack", "Hanyok", "doubtful", "Herrick"]),
    ("wiki-tonkin", "https://en.wikipedia.org/wiki/Gulf_of_Tonkin_incident", ["Herrick", "doubtful", "Freak weather", "overeager"]),
    ("fred-cpi", "https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCNS", ["1913-01", "1913-12", "2025-12", "2026-0"]),
    ("stlfed-owns", "https://www.stlouisfed.org/in-plain-english/who-owns-the-federal-reserve-banks", ["stock", "dividend", "Treasury", "sold"]),
    ("fed-faq-owns", "https://www.federalreserve.gov/faqs/about_14986.htm", ["owned", "stock", "Treasury", "dividend"]),
    ("fedhist-jekyll", "https://www.federalreservehistory.org/essays/jekyll-island-conference",
     ["1910", "Aldrich", "Warburg", "Vanderlip", "first name", "Davison", "Strong", "Piatt Andrew", "secre"]),
    ("fedhist-act", "https://www.federalreservehistory.org/essays/federal-reserve-act-signed", ["December 23", "Board", "Senate", "Glass"]),
    ("wiki-mmm", "https://en.wikipedia.org/wiki/Modern_Money_Mechanics", ["1961", "1992", "Nichols", "Zeitgeist", "edition"]),
    ("wiki-zeitgeist", "https://en.wikipedia.org/wiki/Zeitgeist:_The_Movie",
     ["income tax", "Federal Income Tax", "New York Times", "Feuer", "moved away", "Massey", "Acharya", "Ehrman", "Aaron Russo", "Part III", "premiere"]),
    ("wiki-massey", "https://en.wikipedia.org/wiki/Gerald_Massey", ["1828", "1907", "died", "Egypt"]),
    ("wiki-graves", "https://en.wikipedia.org/wiki/Kersey_Graves", ["1875", "Sixteen", "1813", "1883"]),
    ("wiki-lusitania", "https://en.wikipedia.org/wiki/Sinking_of_the_RMS_Lusitania", ["1,198", "128", "Americans", "1,266", "cartridges", "shrapnel", "warning"]),
    ("irs-frivolous", "https://www.irs.gov/privacy-disclosure/the-truth-about-frivolous-tax-arguments-section-i-a-to-c",
     ["Sixteenth Amendment", "1913", "ratified", "no law"]),
    ("wiki-chrono354", "https://en.wikipedia.org/wiki/Chronography_of_354", ["Christ", "December", "natus", "Bethlehem", "Depositio"]),
    ("bas-mcgowan", "https://www.biblicalarchaeology.org/daily/people-cultures-in-the-bible/jesus-historical-jesus/how-december-25-became-christmas/",
     ["Sol Invictus", "274", "March 25", "Tertullian", "calculation", "Aurelian", "no one"]),
    ("wiki-mithraism", "https://en.wikipedia.org/wiki/Mithraism", ["rock-birth", "born from a rock", "petra genetrix", "December 25", "25 December", "no written"]),
    ("wiki-horus", "https://en.wikipedia.org/wiki/Horus", ["conceived", "Isis", "virgin", "Four sons", "Ra-Horakhty", "Horakhty"]),
    ("wiki-jcm", "https://en.wikipedia.org/wiki/Jesus_in_comparative_mythology", ["Horus", "Massey", "Zeitgeist", "Ehrman", "Mithras", "Krishna", "dying-and-rising", "Smith"]),
    ("wiki-dying-rising", "https://en.wikipedia.org/wiki/Dying-and-rising_god", ["J. Z. Smith", "Jonathan Z. Smith", "Mettinger", "Frazer", "inappropriate"]),
    ("wiki-mausala", "https://en.wikipedia.org/wiki/Mausala_Parva", ["Jara", "arrow", "deer", "foot"]),
    ("wiki-krishna", "https://en.wikipedia.org/wiki/Krishna", ["Jara", "arrow", "hunter"]),
    ("wiki-ehrman-dje", "https://en.wikipedia.org/wiki/Did_Jesus_Exist%3F_(Ehrman_book)", ["Zeitgeist", "Acharya", "Freke", "Tacitus", "Josephus"]),
    ("wiki-tacitus", "https://en.wikipedia.org/wiki/Tacitus_on_Jesus", ["Christus", "Pontius", "Pilatus", "116", "Annals"]),
    ("wiki-historicity", "https://en.wikipedia.org/wiki/Historicity_of_Jesus", ["virtually all", "scholars", "baptized", "crucified", "Pilate"]),
    ("archives-ike", "https://www.archives.gov/milestone-documents/president-dwight-d-eisenhowers-farewell-address", ["unwarranted influence", "military-industrial", "January 17"]),
    ("wiki-racket", "https://en.wikipedia.org/wiki/War_Is_a_Racket", ["public domain", "copyright", "1935", "Round Table"]),
    ("nist-wtc7-faq", "https://www.nist.gov/topics/disaster-failure-studies/faqs-nist-wtc-7-investigation", ["column 79", "fire", "thermal expansion", "first known"]),
    ("wiki-jn25", "https://en.wikipedia.org/wiki/JN-25", ["Pearl Harbor", "1941", "readable", "percent"]),
    ("wiki-mccollum", "https://en.wikipedia.org/wiki/McCollum_memo", ["October 7, 1940", "eight", "Roosevelt", "no evidence", "never"]),
    ("wiki-dayofdeceit", "https://en.wikipedia.org/wiki/Day_of_Deceit", ["historians", "reject", "Budiansky", "Prados"]),
    ("wiki-pinch", "https://en.wikipedia.org/wiki/Geraldine_Pinch", ["Egyptian Mythology", "2002", "Oxford"]),
    ("wiki-attis", "https://en.wikipedia.org/wiki/Attis", ["Nana", "almond", "pomegranate"]),
    ("wiki-dionysus", "https://en.wikipedia.org/wiki/Dionysus", ["Semele", "mortal"]),
    ("wiki-sirius-orion", "https://en.wikipedia.org/wiki/Orion%27s_Belt", ["Three Kings", "Three Marys", "Sirius"]),
    ("wiki-magi", "https://en.wikipedia.org/wiki/Biblical_Magi", ["three", "number", "kings", "Matthew"]),
    ("wiki-zimmermann", "https://en.wikipedia.org/wiki/Zimmermann_Telegram", ["Mexico", "January 1917", "April 1917"]),
    ("skeptoid-196", "https://skeptoid.com/episodes/4196", ["Zeitgeist", "New York Times", "moved away", "Massey", "income tax"]),
    # Tarifas públicas
    ("price-elevenlabs-api", "https://elevenlabs.io/pricing/api", ["per 1K", "1K characters", "Multilingual", "Flash", "per minute", "$"]),
    ("price-elevenlabs", "https://elevenlabs.io/pricing", ["Creator", "Pro", "credits", "characters", "$22", "$99", "$5"]),
    ("price-heygen-api", "https://www.heygen.com/api-pricing", ["credit", "Avatar IV", "per minute", "per second", "$", "Pro", "Scale"]),
    ("price-heygen-help", "https://help.heygen.com/en/articles/10060327-heygen-api-pricing-explained", ["credit", "Avatar IV", "minute", "second", "$"]),
    ("price-heygen-docs", "https://docs.heygen.com/docs/limits", ["credit", "minute", "Avatar IV"]),
    ("price-did", "https://www.d-id.com/pricing/api/", ["minute", "$", "Build", "Launch", "Scale"]),
    ("price-openai", "https://openai.com/api/pricing/", ["image", "gpt-image", "per image", "1024"]),
    ("price-openai-docs", "https://developers.openai.com/api/docs/pricing", ["gpt-image", "per image", "Low", "Medium", "High"]),
    ("price-gh-actions", "https://docs.github.com/en/billing/reference/actions-runner-pricing", ["Linux", "2-core", "$0.", "per minute"]),
    ("price-gh-minutes", "https://docs.github.com/en/billing/concepts/product-billing/github-actions", ["2,000", "free", "public repositories", "minutes"]),
    ("price-runway", "https://docs.dev.runwayml.com/guides/pricing/", ["credit", "gen4", "per second", "$0.01"]),
    ("price-fal-recraft", "https://fal.ai/models/fal-ai/recraft/v3/text-to-image", ["$", "per image", "megapixel"]),
]


def fetch(url: str) -> tuple[int, bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/pdf,text/csv,*/*", "Accept-Language": "en"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, r.read(), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, e.read() or b"", e.headers.get("Content-Type", "") if e.headers else ""
    except Exception as e:  # noqa: BLE001
        return 0, str(e).encode(), "error"


def to_text(body: bytes, ctype: str, url: str) -> str:
    if "pdf" in ctype or url.endswith(".pdf") or body[:4] == b"%PDF":
        open("/tmp/src.pdf", "wb").write(body)
        try:
            return subprocess.run(["pdftotext", "-layout", "/tmp/src.pdf", "-"], capture_output=True, text=True, check=True).stdout
        except (OSError, subprocess.CalledProcessError):
            from pypdf import PdfReader
            return "\n".join((pg.extract_text() or "") for pg in PdfReader("/tmp/src.pdf").pages)
    t = body.decode("utf-8", "replace")
    if "csv" in ctype or url.endswith("CPIAUCNS"):
        return t
    t = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", t)
    t = re.sub(r"(?s)<[^>]+>", " ", t)
    return re.sub(r"\s+", " ", html.unescape(t))


def main() -> int:
    summary = {}
    only = set(sys.argv[1:])
    for sid, url, keys in SOURCES:
        if only and sid not in only:
            continue
        status, body, ctype = fetch(url)
        text = to_text(body, ctype, url) if status else body.decode("utf-8", "replace")
        print(f"\n===== {sid} | HTTP {status} | {len(text)} chars | {url}")
        hits = 0
        for k in keys:
            ms = [m.start() for m in re.finditer(re.escape(k), text, re.I)][:3]
            for i in ms:
                hits += 1
                print(f"  [{k}] …{text[max(0, i - 220):i + 280].replace(chr(10), ' ')}…")
            if not ms:
                print(f"  [{k}] (sin coincidencias)")
        if sid == "fred-cpi" and status == 200:
            rows = [r.split(",") for r in text.strip().splitlines()[1:]]
            print("  CPI first/last:", rows[:2], rows[-3:])
        summary[sid] = {"http": status, "chars": len(text), "hits": hits}
    print("\nRESUMEN", json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
