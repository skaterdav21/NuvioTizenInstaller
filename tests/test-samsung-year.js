"use strict";
const assert = require("node:assert");
const { yearFromModel } = require("../nodejs-project/src/platforms/samsung-year");
const cases = [
  ["UN46F6400AF", 2013, "orsay"], ["UN55H6350", 2014, "orsay"], ["UN65HU8550", 2014, "orsay"], ["UN46ES6500", 2012, "orsay"],
  ["UN32EH4003", 2012, "orsay"], ["UN55D8000", 2011, "orsay"], ["UN40C5000", 2010, "orsay"], ["UN55FH6030", 2013, "orsay"],
  ["UN48J5200", 2015, "tizen-old"], ["UN55JU6500", 2015, "tizen-old"], ["UN65JS8500", 2015, "tizen-old"], ["UN50KU6300", 2016, "tizen-old"],
  ["UN55KS8000", 2016, "tizen-old"], ["UE55MU6100", 2017, "tizen-old"], ["UN32M4500", 2017, "tizen-old"], ["QN65Q7FAMFXZA", 2017, "tizen-old"],
  ["QN55Q8C", 2017, "tizen-old"], ["QN65Q9F", 2017, "tizen-old"], ["UN55LS003", 2017, "tizen-old"],
  ["UN55NU7100", 2018, "tizen"], ["UN43N5300", 2018, "tizen"], ["QN65Q7FN", 2018, "tizen"], ["UN65RU7100", 2019, "tizen"],
  ["QN65Q70R", 2019, "tizen"], ["QN82Q900R", 2019, "tizen"], ["UN65TU7000", 2020, "tizen"], ["QN65Q80T", 2020, "tizen"],
  ["UN65AU8000", 2021, "tizen"], ["QN65QN90A", 2021, "tizen"], ["QN65Q60BAFXZA", 2022, "tizen"], ["QN55LS03B", 2022, "tizen"],
  ["UN65CU7000", 2023, "tizen"], ["QN65QN90C", 2023, "tizen"], ["UN65DU7200", 2024, "tizen"], ["QN65Q80DAFXZA", 2024, "tizen"],
  ["UN65U8000F", 2025, "tizen"], ["QN65Q7FAAFXZA", 2025, "tizen"], ["QN65QN90F", 2025, "tizen"]
];
for (const [model, year, gen] of cases) {
  const r = yearFromModel(model);
  assert.strictEqual(r.year, year, `${model}: year ${r.year}, expected ${year}`);
  assert.strictEqual(r.generation, gen, `${model}: ${r.generation}`);
}
assert.strictEqual(yearFromModel("", "16_JAZZM_UHD").year, 2016);
assert.strictEqual(yearFromModel("QN65Q7F").sure, false, "plain Q7F is ambiguous");
assert.strictEqual(yearFromModel("hello").year, 0);
assert.strictEqual(yearFromModel("UN46F6400").os, "Orsay");
assert.strictEqual(yearFromModel("UN55MU6300").os, "Tizen 3.0");
console.log(`samsung-year: ${cases.length + 5} checks passed`);
