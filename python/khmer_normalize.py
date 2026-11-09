"""
Khmer text normalisation for text-to-speech.

TTS models read characters, not maths — they cannot turn "2026" into
"ពីរពាន់ម្ភៃប្រាំមួយ". Any digits left in the text get mumbled or skipped, which
is why raw news text only comes out partly correct. This module rewrites the
text the way a Khmer speaker would actually say it, before it reaches the model.

Handles: Khmer digits (០-៩) and Arabic digits (0-9), large numbers, ordinals
(ទី12 → ទីដប់ពីរ), years, percentages, currency and decimals.

Mixed Khmer/English is normalised run by run, which matters more than it
sounds. Khmer UI copy is full of English product words — "ជ្រើសរើសយក Food &
Drink រួចចុច Button Create my store" — and rewriting a *whole* mixed string as
Khmer turned "Save 50% today" into "Save ហាសិបភាគរយ today": an English
sentence with a Khmer number read out in the middle of it. Each run is now
normalised in its own language, and English shorthand ("&", "u") is spelled
out, because the model mumbles bare symbols and single letters.

    from khmer_normalize import normalize_for_speech
    normalize_for_speech("ថ្ងៃទី12 ខែឧសភា ឆ្នាំ2026")
    # 'ថ្ងៃទីដប់ពីរ ខែឧសភា ឆ្នាំពីរពាន់ម្ភៃប្រាំមួយ'
    normalize_for_speech("ជ្រើសរើសយក Food & Drink")
    # 'ជ្រើសរើសយក Food and Drink'
"""

from __future__ import annotations

import re

# ── Khmer number vocabulary ──────────────────────────────────────────────────
KHMER_DIGITS = "០១២៣៤៥៦៧៨៩"

# 0–9. Note 6–9 are built base-5 ("five-one", "five-two", …), as Khmer does.
ONES = [
    "សូន្យ", "មួយ", "ពីរ", "បី", "បួន",
    "ប្រាំ", "ប្រាំមួយ", "ប្រាំពីរ", "ប្រាំបី", "ប្រាំបួន",
]

# Multiples of ten. 30–90 are a separate borrowed set, not built from ONES.
TENS = {
    1: "ដប់", 2: "ម្ភៃ", 3: "សាមសិប", 4: "សែសិប", 5: "ហាសិប",
    6: "ហុកសិប", 7: "ចិតសិប", 8: "ប៉ែតសិប", 9: "កៅសិប",
}

# Khmer counts in single units (ម៉ឺន = 10,000), not Western 3-digit groups.
SCALES = [
    (1_000_000_000, "ប៊ីលាន"),
    (1_000_000, "លាន"),
    (100_000, "សែន"),
    (10_000, "ម៉ឺន"),
    (1_000, "ពាន់"),
    (100, "រយ"),
]

UNITS = {"%": "ភាគរយ", "$": "ដុល្លារ", "៛": "រៀល", "°": "អង្សា"}

# ── English runs ─────────────────────────────────────────────────────────────
# Symbols and shorthand the model skips or mumbles. Deliberately short: only
# things with a single unambiguous reading. Digits are left alone — English
# digits are read correctly, and rewriting them is what broke mixed text.
_EN_SYMBOLS = {
    "&": " and ",
    "@": " at ",
    "+": " plus ",
    "=": " equals ",
    "%": " percent ",
}
_EN_WORDS = {
    "u": "you", "ur": "your", "pls": "please", "plz": "please",
    "thx": "thanks", "ty": "thank you", "b4": "before", "ok": "okay",
}
#: "$20" reads as "20 dollars" in English — the opposite order to Khmer.
_EN_CURRENCY = re.compile(r"\$\s*([0-9][0-9,.]*)")


def _below_hundred(n: int) -> str:
    if n < 10:
        return ONES[n]
    tens, ones = divmod(n, 10)
    return TENS[tens] + (ONES[ones] if ones else "")


def number_to_khmer(n: int) -> str:
    """Write an integer the way it is spoken in Khmer."""
    if n < 0:
        return "ដក" + number_to_khmer(-n)
    if n < 100:
        return _below_hundred(n)

    for value, word in SCALES:
        if n >= value:
            count, remainder = divmod(n, value)
            head = number_to_khmer(count) + word
            return head + (number_to_khmer(remainder) if remainder else "")
    return ONES[n]  # unreachable


def _digits_to_int(text: str) -> int:
    """Accept Khmer or Arabic digits."""
    out = []
    for ch in text:
        if ch in KHMER_DIGITS:
            out.append(str(KHMER_DIGITS.index(ch)))
        elif ch.isdigit():
            out.append(ch)
    return int("".join(out)) if out else 0


def _spell_number(raw: str) -> str:
    """Turn one numeric token (may contain , . digits) into Khmer words."""
    raw = raw.replace(",", "")
    if "." in raw:
        whole, _, frac = raw.partition(".")
        spoken = number_to_khmer(_digits_to_int(whole)) + "ចុច"
        # decimals are read digit by digit
        spoken += "".join(ONES[_digits_to_int(d)] for d in frac if d.strip())
        return spoken
    return number_to_khmer(_digits_to_int(raw))


# Any run of Khmer or Arabic digits, optionally with thousands separators/decimals
_NUMBER = re.compile(r"[0-9០-៩][0-9០-៩,.]*")


def has_khmer(text: str) -> bool:
    """True if the text contains Khmer script, so we only apply Khmer number
    words to Khmer text (an English sentence must keep its own numbers)."""
    return any("ក" <= ch <= "៿" for ch in text)


def _is_khmer_letter(ch: str) -> bool:
    return "ក" <= ch <= "៿"


def _is_latin_letter(ch: str) -> bool:
    return ("a" <= ch <= "z") or ("A" <= ch <= "Z")


def split_scripts(text: str) -> list[tuple[bool, str]]:
    """Break text into runs of [(is_khmer, segment), ...].

    Digits, spaces, punctuation and symbols carry no script of their own, so
    each joins the run it sits in — the script of the nearest letter before it,
    or of the first letter in the text when it comes first. That is what keeps
    "50%" Khmer in "តម្លៃ 50%" and English in "Save 50% today".
    """
    if not text:
        return []

    first = next(
        (_is_khmer_letter(c) for c in text if _is_khmer_letter(c) or _is_latin_letter(c)),
        None,
    )
    if first is None:
        return [(True, text)]        # no letters at all, so script is moot

    runs: list[tuple[bool, str]] = []
    current, buffer = first, []
    for ch in text:
        if _is_khmer_letter(ch) or _is_latin_letter(ch):
            script = _is_khmer_letter(ch)
            if script != current and buffer:
                runs.append((current, "".join(buffer)))
                buffer = []
            current = script
        buffer.append(ch)
    if buffer:
        runs.append((current, "".join(buffer)))
    return runs


def _tidy(text: str) -> str:
    """Collapse whitespace, and never leave a space before punctuation. The
    khan (។) stays put: it is what makes the model pause."""
    text = re.sub(r"[ \t\u00a0]+", " ", text)
    text = re.sub(r"\s+([។៕,.?!])", r"\1", text)
    return text.strip()


def normalize_khmer(text: str) -> str:
    """Rewrite one Khmer run the way a Khmer speaker would say it."""
    if not text:
        return text

    # Units attached to a number: 50% → ហាសិបភាគរយ
    for symbol, word in UNITS.items():
        text = text.replace(symbol, word)

    def repl(match: re.Match) -> str:
        token = match.group(0).rstrip(".,")
        trailing = match.group(0)[len(token):]
        return _spell_number(token) + trailing

    return _tidy(_NUMBER.sub(repl, text))


def normalize_english(text: str) -> str:
    """Spell out the symbols and shorthand an English run hides.

    Digits stay digits: the model reads English numbers correctly on its own.
    """
    if not text:
        return text

    text = _EN_CURRENCY.sub(lambda m: f" {m.group(1)} dollars ", text)
    for symbol, word in _EN_SYMBOLS.items():
        text = text.replace(symbol, word)

    def word_repl(match: re.Match) -> str:
        word = match.group(0)
        spelled = _EN_WORDS.get(word.lower())
        if spelled is None:
            return word
        return spelled.capitalize() if word[0].isupper() else spelled

    return _tidy(re.sub(r"[A-Za-z0-9]+", word_repl, text))


def normalize_for_speech(text: str) -> str:
    """Normalise text of any script mix, each run in its own language."""
    if not text:
        return text
    parts = [
        normalize_khmer(segment) if is_khmer else normalize_english(segment)
        for is_khmer, segment in split_scripts(text)
    ]
    return _tidy(" ".join(part for part in parts if part))


if __name__ == "__main__":
    samples = [
        "លោក ប៉េង ពោធិ៍នា រដ្ឋមន្រ្តីក្រសួងសាធារណការ និងដឹកជញ្ជូន ព្រឹកថ្ងៃទី12 ខែឧសភា "
        "ឆ្នាំ2026  បានអញ្ជើញជាអធិបតីក្នុងមហាសន្និបាតភាគហ៊ុនិកលើកទី១១ របស់កំពង់ផែស្វយ័តភ្នំពេញ។",
        "ថ្ងៃទី1 ខែមករា ឆ្នាំ2000",
        "តម្លៃ 1,250 ដុល្លារ និង 50% នៃចំណូល",
    ]
    samples += [
        "ចំណែងកន្លែង What do u sell? ជ្រើសរើសយក Food & Drink រួចចុច Button Create my store ជាការស្រេច",
        "Save 50% today ជាការស្រេច",
        "តម្លៃ 50% និង Costs $20 only",
    ]
    for s in samples:
        print("IN :", s)
        print("OUT:", normalize_for_speech(s))
        print()
    for n in [0, 5, 7, 10, 11, 12, 20, 26, 45, 99, 100, 111, 1000, 2026, 10000, 100000, 1000000]:
        print(f"{n:>9} -> {number_to_khmer(n)}")
