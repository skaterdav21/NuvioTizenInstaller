"use strict";
const mock = require("./mock-adbd.js");
const { shell } = require("./fake-shield.js");
mock.start({ port: 25556, maxdata: 4096, shell, banner: "device::ro.product.name=sif;ro.product.model=SHIELD Android TV;ro.product.device=sif;" }).then(() => console.log("mock shield on 25556"));
