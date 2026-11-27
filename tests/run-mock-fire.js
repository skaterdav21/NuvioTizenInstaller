"use strict";
const mock = require("./mock-adbd.js");
const { shell } = require("./fake-fire.js");
mock.start({ port: 25559, maxdata: 4096, shell, banner: "device::ro.product.name=karat;ro.product.model=AFTKRT;ro.product.device=kara;" }).then(() => console.log("mock fire tv on 25559"));
