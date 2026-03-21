var i=Object.create;var n=Object.defineProperty;var v=Object.getOwnPropertyDescriptor;var k=Object.getOwnPropertyNames;var T=Object.getPrototypeOf,_=Object.prototype.hasOwnProperty;var u=(t,r)=>()=>(r||t((r={exports:{}}).exports,r),r.exports);var a=(t,r,e,o)=>{if(r&&typeof r=="object"||typeof r=="function")for(let s of k(r))!_.call(t,s)&&s!==e&&n(t,s,{get:()=>r[s],enumerable:!(o=v(r,s))||o.enumerable});return t};var m=(t,r,e)=>(e=t!=null?i(T(t)):{},a(r||!t||!t.__esModule?n(e,"default",{value:t,enumerable:!0}):e,t));var p=u(l=>{"use strict";var c=Symbol.for("react.transitional.element"),f=Symbol.for("react.fragment");function j(t,r,e){var o=null;if(e!==void 0&&(o=""+e),r.key!==void 0&&(o=""+r.key),"key"in r){e={};for(var s in r)s!=="key"&&(e[s]=r[s])}else e=r;return r=e.ref,{$$typeof:c,type:t,key:o,ref:r!==void 0?r:null,props:e}}l.Fragment=f;l.jsx=j;l.jsxs=j});var d=u((P,E)=>{"use strict";E.exports=p()});var x=m(d()),R=x.default.jsx,q=x.default.jsxs,C=x.default.Fragment,M=x.default;export{C as Fragment,M as default,R as jsx,q as jsxs};
/*! Bundled license information:

react/cjs/react-jsx-runtime.production.js:
  (**
   * @license React
   * react-jsx-runtime.production.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)
*/
