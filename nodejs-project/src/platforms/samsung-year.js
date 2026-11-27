// Works out a Samsung TV's model year from its model number (the sticker on the back, or the TV's
// own API), and what that year means for Nuvio:
//   2018 and newer  Tizen 4+       Nuvio Legacy installs (this app's normal Samsung flow)
//   2015 to 2017    Tizen 2.3-3.0  Developer Mode exists, but no Nuvio build runs there
//   2010 to 2014    Orsay          "develop" account + User App Sync; Nuvio can't run there
"use strict";

const TIZEN_BY_YEAR = { 2015: "2.3", 2016: "2.4", 2017: "3.0", 2018: "4.0", 2019: "5.0", 2020: "5.5", 2021: "6.0", 2022: "6.5", 2023: "7.0", 2024: "8.0", 2025: "9.0", 2026: "10.0" };
const NEW_LETTER = { N: 2018, R: 2019, T: 2020, A: 2021, B: 2022, C: 2023, D: 2024, F: 2025, H: 2026 };
const OLD_LETTER = { C: 2010, D: 2011, E: 2012, F: 2013, H: 2014, J: 2015, K: 2016, M: 2017, N: 2018 };

function describe(year, sure, how) {
  if (!year) return { year: 0, sure: false, how: "", generation: "unknown", os: "", supported: null };
  const generation = year >= 2018 ? "tizen" : year >= 2015 ? "tizen-old" : "orsay";
  const os = year >= 2015 ? `Tizen ${TIZEN_BY_YEAR[year] || "?"}` : "Orsay";
  return { year, sure, how, generation, os, supported: year >= 2018 };
}

// model: "UN46F6400AF", "QN65Q80DAFXZA", "UE55MU6100", "QN55LS03B"...; apiModel: "16_JAZZM_UHD" style.
function yearFromModel(model = "", apiModel = "") {
  const api = String(apiModel).match(/^(\d\d)_/);
  if (api && Number(api[1]) >= 15 && Number(api[1]) <= 40) return describe(2000 + Number(api[1]), true, "the TV reported it");
  const full = String(model || "").toUpperCase().replace(/[\s-]/g, "");
  if (!full) return describe(0);
  const rest = full.replace(/^[A-Z]{2}\d{2,3}/, "");

  // The Frame: LS03B (2022). LS003 with no letter is the 2017 original.
  let m = rest.match(/^LS0?\d{2}([A-Z])?/);
  if (m) return m[1] && NEW_LETTER[m[1]] ? describe(NEW_LETTER[m[1]], true, "model letter") : describe(2017, false, "The Frame without a year letter");

  // QLED / Neo QLED: Q80D, QN90B, Q60R, Q900R, Q7FN (2018), Q7F/Q9F/Q8C (2017, or 2025 for Q7F/Q8F).
  m = rest.match(/^Q(N)?(\d{1,3})([A-Z])([A-Z]{0,3})/);
  if (m) {
    const [, neo, digits, letter, after] = m;
    if (!neo && digits.length === 1) {
      if (after.startsWith("N")) return describe(2018, true, "model letters");
      if (letter === "C") return describe(2017, true, "2017 curved QLED");
      if (letter === "F") {
        if (digits === "9") return describe(2017, true, "2017 QLED");
        if (/^AM/.test(after)) return describe(2017, true, "2017 QLED");
        if (/^AA/.test(after) || digits === "6") return describe(2025, true, "2025 QLED");
        return describe(digits === "8" ? 2025 : 2017, false, "Q7F was sold in 2017 and 2025");
      }
    }
    if (NEW_LETTER[letter]) return describe(NEW_LETTER[letter], true, "model letter");
  }

  // Crystal UHD 2018-2024: NU7100, RU7100, TU8000, AU8000, BU8000, CU7000, DU7200. 2025: U8000F.
  m = rest.match(/^([NRTABCD])U\d{4}/);
  if (m) return describe(NEW_LETTER[m[1]], true, "model letter");
  if (/^U\d{4}F/.test(rest)) return describe(2025, true, "model letter");
  // Full HD 2018-2020 without the U: N5300, T5300.
  m = rest.match(/^([NRT])\d{4}/);
  if (m) return describe(NEW_LETTER[m[1]], true, "model letter");

  // 2010-2017: C/D/E/F/H/J/K/M then 4 digits, sometimes with a second letter (ES, EH, FH, HU, JU, JS, KU, KS, MU).
  m = rest.match(/^([CDEFHJKM])[A-Z]?\d{4}/);
  if (m) return describe(OLD_LETTER[m[1]], true, "model letter");
  return describe(0);
}

// Year picked by hand when the model number doesn't settle it.
function fromYear(year) {
  return describe(Number(year) || 0, true, "picked by hand");
}

module.exports = { yearFromModel, fromYear, TIZEN_BY_YEAR };
