const E=process.env.E2E_HOME||"/workspace/atomivid-recraft/.e2e-local"; const fs=require("fs");
const { chromium } = require(E+"/deps/node_modules/playwright"); const { Client } = require(E+"/deps/node_modules/pg");
const CH=fs.readFileSync(E+"/paths.env","utf8").match(/CHROME=(.*)/)[1];
const BASE="http://127.0.0.1:3100", OUT=process.env.LF_OUT||"/workspace/atomivid-mission/lf/out"; fs.mkdirSync(OUT,{recursive:true});
const OWNER={id:"11111111-1111-4111-8111-111111111111",email:"pilot-owner@local.test",password:"local-pass-owner-1"};
async function db(){const c=new Client({connectionString:`postgres://postgres@localhost:55432/atomivid?host=${E}/run`});await c.connect();return c;}
async function login(){const b=await chromium.launch({executablePath:CH});const ctx=await b.newContext({viewport:{width:1280,height:900},acceptDownloads:true});const p=await ctx.newPage();p.setDefaultTimeout(180000);
 await p.goto(BASE+"/login");await p.fill("input[name=email]",OWNER.email);await p.fill("input[name=password]",OWNER.password);await p.locator("form button[type=submit]").last().click();await p.waitForURL(/\/dashboard/);return {b,p};}
const log=(...a)=>{const l=a.map(x=>typeof x==="string"?x:JSON.stringify(x)).join(" ");console.log(l);fs.appendFileSync(OUT+"/journal.log",new Date().toISOString()+" "+l+"\n");};
const shot=(p,n)=>p.screenshot({path:`${OUT}/${n}.png`,fullPage:true});
const skipTour=(p)=>p.getByRole("button",{name:"Omitir"}).click({timeout:5000}).catch(()=>{});
module.exports={E,BASE,OUT,OWNER,db,login,log,shot,skipTour,fs};
