/** Approved Hans look (warm/tan skin-selective grade, local ffmpeg, USD 0) shared by the V2 stages. Same graph as the V1 master. */
/** Retoque local v2 (look cálido/bronceado aprobado por Hans), USD 0.00, sin geometría:
 * - base: denoise leve, altas luces contenidas (contraluz de la ventana), contraste y calidez globales MUY leves;
 * - piel: máscara local por crominancia (Cb/Cr de piel; excluye camisa blanca, pared y ventana), cerrada y
 *   difuminada para incluir cara, cuello y manos por igual; sobre ella: suavizado que respeta bordes,
 *   medios tonos algo más profundos (bronceado), calidez dorada y saturación selectiva;
 * - mezcla con maskedmerge (la máscara se arma desde un único plano gris en los tres planos) + nitidez discreta. */
export const SKIN_MASK = "clip((cr(X,Y)-131)/9,0,1)*clip((180-cr(X,Y))/10,0,1)*clip((cb(X,Y)-78)/8,0,1)*clip((130-cb(X,Y))/6,0,1)*clip((lum(X,Y)-35)/25,0,1)*255";
export const RETOUCH_GRAPH = (input: string, output: string) =>
  `[${input}]format=yuv444p,hqdn3d=1.5:1.5:3:3,split=3[ra][rb][rc];` +
  `[ra]curves=all='0/0 0.25/0.235 0.6/0.61 0.85/0.82 1/0.93',eq=contrast=1.06:saturation=1.04,colorbalance=rm=0.01:bm=-0.012,format=yuv444p[rbase];` +
  `[rb]smartblur=lr=2.5:ls=0.6:lt=6,curves=all='0/0 0.25/0.235 0.6/0.61 0.85/0.82 1/0.93',curves=all='0/0 0.35/0.33 0.65/0.59 0.9/0.83 1/0.95',` +
  `colorbalance=rs=0.03:bs=-0.04:rm=0.08:gm=0.015:bm=-0.08:rh=0.03:bh=-0.04,eq=contrast=1.08:saturation=1.2,format=yuv444p[rskin];` +
  `[rc]scale=iw/4:ih/4,geq=lum='${SKIN_MASK}':cb=128:cr=128,format=gray,dilation,dilation,erosion,gblur=sigma=3,scale=iw*4:ih*4:flags=bicubic,split=3[rm1][rm2][rm3];` +
  `[rm1][rm2][rm3]mergeplanes=0x001020:yuv444p[rmask];[rbase][rskin][rmask]maskedmerge,unsharp=5:5:0.45:5:5:0,format=yuv420p[${output}]`;

/**
 * The new takes are HLG (arib-std-b67, BT.2020). Proper HDR → SDR (BT.709) conversion before the look,
 * so VFX source and master are true SDR (no washed-out HLG-as-709 rendering).
 */
export const HLG_TO_SDR = (op: "hable" | "mobius" | "clip" = "hable", npl = 100) =>
  `zscale=tin=arib-std-b67:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=${npl},format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=${op}:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`;
