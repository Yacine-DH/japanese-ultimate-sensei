import * as THREE from 'three';

/** Ink Dojo: particles write one kanji per section over a drifting ink-wash landscape. */
const NOISE = `
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float a=.5,s=0.;for(int i=0;i<5;i++){s+=a*vn(p);p=mat2(1.6,1.2,-1.2,1.6)*p;a*=.5;}return s;}`;

export function createInk(canvas, { reduced }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  cam.position.z = 9;
  const phone = innerWidth < 820;
  const N = phone ? 26000 : 80000;

  const bg = {
    t: { value: 0 }, r: { value: 1 }, m: { value: new THREE.Vector2() }, v: { value: 0 }, e: { value: 0 },
    ea: { value: 0 }, ex: { value: 0.2 }, sun: { value: 1 }, side: { value: -1 }, narrow: { value: 0 }, sx: { value: 0.12 },
  };
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, uniforms: bg,
      vertexShader: 'varying vec2 u;void main(){u=uv;gl_Position=vec4(position.xy,0.,1.);}',
      fragmentShader: NOISE + `varying vec2 u;uniform float t,r,v,e,ea,ex,sun,side,narrow,sx;uniform vec2 m;
      void main(){
        vec2 p=vec2((u.x-.5)*r,u.y-.5);
        vec3 paper=vec3(.902,.914,.906);
        float fib=fbm(p*vec2(90.,14.)+fbm(p*8.)*4.)*.5+fbm(p*vec2(16.,120.))*.5;
        vec3 c=paper+(fib-.5)*.045;
        vec2 sp=p-vec2(sx*r+m.x*.01,.23+m.y*.008);float sd=length(sp)+(fbm(p*26.)-.5)*.012;
        float s=smoothstep(.118,.108,sd)*(.82+.25*fbm(p*9.));
        c=mix(c,vec3(.80,.19,.13),s*.92*sun);
        for(int i=0;i<6;i++){
          float k=float(i)/5.;
          vec2 q=vec2(p.x*(1.5+k*.5)+float(i)*7.3+v*(.12+k*.5)+m.x*(.01+k*.05),0.);
          float h=-.10-k*.30+m.y*.02*k+(fbm(q*1.5+float(i))-.45)*(.62-k*.22)+(fbm(q*7.)-.5)*.05;
          float d=h-p.y;
          float edge=smoothstep(-.004,.012+.02*vn(p*40.),d);
          float wash=exp(-max(d,0.)*(7.-k*2.));
          float gr=fbm(vec2(p.x*9.+float(i)*3.,p.y*24.+q.x*4.));
          float mist=smoothstep(.30,.75,fbm(vec2(p.x*1.6-t*.02*(1.+k)+float(i),p.y*4.+t*.008)));
          float a=edge*wash*(.28+.62*k)*(.62+.6*gr)*(1.-.62*mist);
          c=mix(c,mix(vec3(.30,.35,.45),vec3(.085,.10,.14),k),clamp(a,0.,1.));
          c=mix(c,paper,edge*smoothstep(.0,.34,d)*.5);
        }
        vec2 ep=p-vec2(ex*r,0.);float er=length(ep);float an=fract(atan(ep.x,ep.y)/6.28318);
        float bris=fbm(vec2(er*230.,an*7.));float w=.030*(1.-.45*an)+.006*sin(an*20.);
        float rad=.27-.012*sin(an*6.28);
        float ring=smoothstep(w,w*.35,abs(er-rad))*smoothstep(.25+an*.35,.62,bris+.35*(1.-an));
        ring*=step(an,e)*smoothstep(0.,.01,an);
        float ghost=smoothstep(.004,0.,abs(er-rad))*.22;
        c=mix(c,vec3(.07,.08,.11),max(ring*.95,ghost)*ea);
        // mist where the words are, so text always sits on light paper
        float x=p.x/r*side;
        float veil=smoothstep(-.06,.30,x)*.86;
        veil=mix(veil,.80*smoothstep(.40,.02,p.y+.10)+.12,narrow);
        c=mix(c,paper+(fib-.5)*.03,veil);
        c*=1.-.10*pow(length(p/vec2(r,1.))*1.35,3.);
        gl_FragColor=vec4(c,1.);}`,
    }),
  );
  back.frustumCulled = false;
  back.renderOrder = -1;
  scene.add(back);

  const cv = document.createElement('canvas');
  const g = cv.getContext('2d', { willReadFrequently: true });
  function sample(text) {
    const L = [...text];
    const S = 240;
    const vertical = L.length > 1;
    cv.width = S + 60;
    cv.height = (vertical ? S * L.length : S) + 60;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#000';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `${S * 0.96}px "Yuji Boku","Yu Mincho",serif`;
    L.forEach((c, i) => g.fillText(c, cv.width / 2, 30 + S * (i + 0.5)));
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    const pts = [];
    for (let y = 0; y < cv.height; y += 2) for (let x = 0; x < cv.width; x += 2) if (d[(y * cv.width + x) * 4] < 110) pts.push(x, y);
    const out = new Float32Array(N * 3);
    const sc = vertical ? 6.2 / cv.height : 3.9 / cv.height;
    const n = pts.length / 2 || 1;
    for (let i = 0; i < N; i++) {
      const k = Math.floor(Math.random() * n) * 2;
      out[i * 3] = ((pts[k] ?? 0) + Math.random() * 2 - cv.width / 2) * sc;
      out[i * 3 + 1] = -((pts[k + 1] ?? 0) + Math.random() * 2 - cv.height / 2) * sc;
      out[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
    }
    return out;
  }
  const geo = new THREE.BufferGeometry();
  const rand = new Float32Array(N * 4).map(() => Math.random());
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  const A = new THREE.BufferAttribute(sample('先生'), 3);
  const B = new THREE.BufferAttribute(A.array.slice(), 3);
  geo.setAttribute('a', A);
  geo.setAttribute('b', B);
  geo.setAttribute('rnd', new THREE.BufferAttribute(rand, 4));
  const pu = { t: bg.t, k: { value: 1 }, px: { value: 1 }, m: { value: new THREE.Vector3(99, 99, 0) }, blow: { value: 0 }, red: { value: 0 }, fade: { value: 1 } };
  const pts = new THREE.Points(
    geo,
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: pu,
      vertexShader: `attribute vec3 a,b;attribute vec4 rnd;uniform float t,k,px,blow;uniform vec3 m;varying float al;varying float rr;
      vec3 sw(vec3 p,float s){return vec3(sin(p.y*1.7+t*.5+s*6.)+cos(p.z*2.3+s*9.),sin(p.x*1.9-t*.4+s*7.)+cos(p.z*1.4+s*4.),cos(p.x*1.6+t*.3)+sin(p.y*1.3+s*5.));}
      void main(){float d=clamp(k*1.9-rnd.x*.9,0.,1.);d=d*d*(3.-2.*d);float arc=sin(d*3.14159);
        vec3 p=mix(a,b,d);p+=sw(p*.8+rnd.y,rnd.z)*arc*(.5+1.3*rnd.w);p+=sw(p*2.,rnd.x)*.012;
        float loose=step(.93,rnd.w);p+=loose*sw(p*.6+t*.05,rnd.z)*(.10+.34*rnd.y)*vec3(1.,1.2,1.4);
        p+=normalize(sw(p,rnd.y)+vec3(0.,.9,0.))*blow*(1.+3.*rnd.x);
        vec4 w=modelMatrix*vec4(p,1.);vec2 dv=w.xy-m.xy;float q=exp(-dot(dv,dv)*2.4);w.xy+=normalize(dv+1e-4)*q*(.28+.5*rnd.y);w.z+=q*rnd.x*.9;
        vec4 mv=viewMatrix*w;gl_Position=projectionMatrix*mv;
        float sz=mix(.016,.042,rnd.z*rnd.z*rnd.z)*(1.+arc*.8)*(1.-.45*loose);gl_PointSize=sz*px/-mv.z;
        al=(.42+.5*rnd.y)*(1.-.5*arc)*(1.-min(blow*.28,.9))*(1.-loose*.35);rr=rnd.x;}`,
      fragmentShader: `varying float al;varying float rr;uniform float red,fade;void main(){float d=length(gl_PointCoord-.5);float a=smoothstep(.5,.18,d)*al*fade;vec3 ink=mix(vec3(.05,.06,.085),vec3(.16,.20,.30),step(.8,rr));ink=mix(ink,vec3(.78,.18,.12),red*step(rr,.5));gl_FragColor=vec4(ink,a);}`,
    }),
  );
  pts.frustumCulled = false;
  const grp = new THREE.Group();
  grp.add(pts);
  scene.add(grp);

  // a few brush-stroke birds
  const NB = 14;
  const birdG = new THREE.BufferGeometry();
  birdG.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.16, 0, 0, -0.16, -0.55, 0, -0.06, 0, 0, 0.16, 0.55, 0, -0.06, 0, 0, -0.16], 3));
  const birds = new THREE.InstancedMesh(birdG, new THREE.ShaderMaterial({ side: THREE.DoubleSide, transparent: true, uniforms: { t: bg.t }, vertexShader: 'uniform float t;void main(){vec3 p=position;float ph=instanceMatrix[3][0]*1.7+instanceMatrix[3][1]*3.;p.y+=abs(p.x)*sin(t*3.2+ph)*.75;gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(p,1.);}', fragmentShader: 'void main(){gl_FragColor=vec4(.10,.12,.17,.8);}' }), NB);
  birds.frustumCulled = false;
  scene.add(birds);
  const flock = Array.from({ length: NB }, (_, i) => ({ o: i * 0.55 + Math.random(), y: 1.5 + Math.random() * 1.1, z: -3 - Math.random() * 3, s: 0.16 + Math.random() * 0.13 }));
  const M = new THREE.Matrix4();
  const Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5, Math.PI / 2 - 0.5, 0));
  const P = new THREE.Vector3();
  const S = new THREE.Vector3();

  let word = '先生';
  let W = 1;
  let narrow = false;
  const st = { side: 'left', enso: 0, scroll: 0, blow: 0, red: 0 };
  const cur = { side: 1, x: 2.2, y: 0.2, s: 1 };
  const ptr = { x: 0, y: 0, tx: 0, ty: 0 };

  function write(text) {
    if (text === word) return;
    word = text;
    const a = A.array;
    const b = B.array;
    const k = pu.k.value;
    for (let i = 0; i < N; i++) {
      let d = Math.min(1, Math.max(0, k * 1.9 - rand[i * 4] * 0.9));
      d = d * d * (3 - 2 * d);
      for (let j = 0; j < 3; j++) a[i * 3 + j] += (b[i * 3 + j] - a[i * 3 + j]) * d;
    }
    b.set(sample(text));
    A.needsUpdate = B.needsUpdate = true;
    pu.k.value = reduced ? 1 : 0;
  }

  let T = 0;
  let lastScroll = 0;
  function frame(dt) {
    T += dt * (reduced ? 0.15 : 1);
    bg.t.value = T;
    const e = reduced ? 1 : 1 - Math.exp(-dt * 3);
    ptr.x += (ptr.tx - ptr.x) * Math.min(1, dt * 5);
    ptr.y += (ptr.ty - ptr.y) * Math.min(1, dt * 5);
    const left = st.side === 'left';
    const enso = st.enso > 0 ? 1 : 0;
    cur.side += ((left ? -1 : 1) - cur.side) * e;
    bg.side.value = cur.side;
    bg.narrow.value += ((narrow ? 1 : 0) - bg.narrow.value) * e;
    bg.m.value.set(ptr.x, ptr.y);
    lastScroll += (st.scroll - lastScroll) * e;
    bg.v.value = lastScroll * 0.0011 + T * 0.004;
    bg.ea.value += (enso - bg.ea.value) * e;
    bg.e.value += (st.enso - bg.e.value) * e * 0.5;
    bg.sun.value += (1 - enso - bg.sun.value) * e;
    bg.sx.value += ((narrow ? -0.2 : left ? 0.12 : -0.12) - bg.sx.value) * e * 0.6;
    const half = Math.tan((cam.fov * Math.PI) / 360) * cam.position.z;
    const gx = narrow ? half * cam.aspect * 0.30 : half * cam.aspect * 0.46 * (left ? 1 : -1);
    const gy = narrow ? half * 0.56 : 0.1;
    const gs = (narrow ? ([...word].length > 1 ? 0.33 : 0.46) : Math.min(1.15, cam.aspect * 0.62)) * (enso ? 0.62 : 1) * ([...word].length > 1 ? 1 : 1.05);
    cur.x += (gx - cur.x) * e * 0.8;
    cur.y += (gy - cur.y) * e;
    cur.s += (gs - cur.s) * e;
    grp.position.set(cur.x, cur.y, 0);
    grp.scale.setScalar(cur.s);
    bg.ex.value = cur.x / (2 * half * cam.aspect);
    grp.rotation.y = ptr.x * 0.4 + Math.sin(T * 0.3) * 0.06;
    grp.rotation.x = -ptr.y * 0.18;
    pu.m.value.set(ptr.x * half * cam.aspect, ptr.y * half, 0);
    pu.k.value = Math.min(1, pu.k.value + dt * 0.62);
    pu.fade.value += ((narrow && st.scroll > innerHeight * 0.5 ? 0.35 : 1) - pu.fade.value) * e;
    st.blow *= Math.exp(-dt * 2.6);
    st.red *= Math.exp(-dt * 1.8);
    pu.blow.value = reduced ? 0 : st.blow;
    pu.red.value = st.red;
    flock.forEach((b, i) => {
      const x = ((b.o * 1.1 + T * 0.32) % 15) - 7.5;
      P.set(x, b.y + Math.sin(T * 0.6 + b.o) * 0.15 + x * 0.05, b.z);
      birds.setMatrixAt(i, M.compose(P, Q, S.setScalar(b.s)));
    });
    birds.instanceMatrix.needsUpdate = true;
    renderer.render(scene, cam);
  }
  function resize() {
    W = innerWidth;
    narrow = W < 820;
    renderer.setPixelRatio(Math.min(devicePixelRatio, narrow ? 1.25 : 1.5));
    renderer.setSize(W, canvas.clientHeight || innerHeight, false);
    cam.aspect = W / (canvas.clientHeight || innerHeight);
    cam.updateProjectionMatrix();
    bg.r.value = cam.aspect;
    pu.px.value = renderer.domElement.height / (2 * Math.tan((cam.fov * Math.PI) / 360));
  }
  addEventListener('resize', resize);
  addEventListener('pointermove', (ev) => {
    ptr.tx = (ev.clientX / innerWidth) * 2 - 1;
    ptr.ty = -((ev.clientY / innerHeight) * 2 - 1);
  }, { passive: true });
  resize();
  let last = performance.now();
  (function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    if (!document.hidden) frame(dt);
  })(last);
  return {
    section(kanji, side, enso) { st.side = side; st.enso = enso; write(kanji); },
    rewrite() { const w = word; word = ''; write(w); pu.k.value = 1; },
    scroll(y) { st.scroll = y; },
    splash(red) { st.blow = 1; st.red = red ? 1 : 0; },
    write,
  };
}
