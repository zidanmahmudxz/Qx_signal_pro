'use strict';
require('dotenv').config();
const bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),db=require('./database');
const SECRET=process.env.JWT_SECRET||'spv5_fallback';
module.exports={
  async ensureAdmin(){
    if(db.userCount()===0){
      const u=process.env.ADMIN_USER||'admin',p=process.env.ADMIN_PASS||'admin123';
      db.saveUser(u,await bcrypt.hash(p,10),'admin');
      console.log(`[AUTH] Admin: ${u}/${p}`);
    }
  },
  async login(u,p){
    const user=db.getUser(u);if(!user)return{ok:false,error:'Invalid credentials'};
    if(!await bcrypt.compare(p,user.password))return{ok:false,error:'Invalid credentials'};
    const token=jwt.sign({id:user.id,username:user.username,role:user.role},SECRET,{expiresIn:'7d'});
    return{ok:true,token,username:user.username,role:user.role};
  },
  verify(t){try{return jwt.verify(t,SECRET);}catch(e){return null;}},
  fromReq(req){const a=req.headers['authorization']||'';const t=a.startsWith('Bearer ')?a.slice(7):null;return t?this.verify(t):null;},
};
