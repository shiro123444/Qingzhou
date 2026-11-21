import { glassVertexShader } from './shader';

/** Two dense, separable passes. Each atlas rectangle clamps to its own texels. */
const fragmentShader = `#version 300 es
precision highp float;
uniform highp sampler2D uInput;
uniform vec2 uSize;
uniform vec4 uRect;
uniform vec2 uAxis;
uniform float uSigma;
uniform bool uFirst;
uniform bool uOpaque;
out vec4 outputColor;
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  ivec2 minimum = ivec2(round(uRect.xy * uSize));
  ivec2 maximum = minimum + ivec2(round(uRect.zw * uSize)) - 1;
  float sigma = max(uSigma, 0.01);
  int radius = int(ceil(min(3.0 * sigma, 96.0)));
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int offset = -radius; offset <= radius; offset++) {
    float weight = exp(-0.5 * pow(float(offset) / sigma, 2.0));
    vec4 color = texelFetch(uInput, clamp(pixel + ivec2(uAxis) * offset, minimum, maximum), 0);
    if (uFirst) {
      color.a = uOpaque ? 1.0 : color.a;
      color.rgb *= color.a;
    }
    sum += color * weight;
    total += weight;
  }
  outputColor = sum / total;
}`;

interface Plane {
  opaque?: boolean;
  size: readonly [number, number];
  uvRect?: readonly [number, number, number, number];
}

/** Inputs are sRGB-decoded by the source texture; intermediates are premultiplied linear light. */
export function createSourcePrefilter(gl: WebGL2RenderingContext) {
  const shaders: WebGLShader[] = [];
  const textures: WebGLTexture[] = [];
  const program = gl.createProgram();
  const framebuffer = gl.createFramebuffer();
  const halfFloat = !!gl.getExtension('EXT_color_buffer_float');
  let signature = '';
  let width = 0;
  let height = 0;
  const dispose = () => {
    textures.forEach((texture) => gl.deleteTexture(texture));
    shaders.forEach((shader) => gl.deleteShader(shader));
    gl.deleteProgram(program);
    gl.deleteFramebuffer(framebuffer);
  };
  try {
    if (!program || !framebuffer) throw new Error('Unable to allocate glass prefilter.');
    for (const [type, source] of [
      [gl.VERTEX_SHADER, glassVertexShader],
      [gl.FRAGMENT_SHADER, fragmentShader],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Unable to allocate glass prefilter shader.');
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader) ?? 'Glass prefilter compilation failed.');
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) ?? 'Glass prefilter linking failed.');
    for (let index = 0; index < 2; index++) {
      const texture = gl.createTexture();
      if (!texture) throw new Error('Unable to allocate glass prefilter texture.');
      textures.push(texture);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
  } catch (error) {
    dispose();
    throw error;
  }
  const uniform = (name: string) => gl.getUniformLocation(program!, name);
  const locations = Object.fromEntries(
    ['uInput', 'uSize', 'uRect', 'uAxis', 'uSigma', 'uFirst', 'uOpaque'].map((name) => [
      name,
      uniform(name),
    ]),
  );
  return {
    dispose,
    invalidate: () => {
      signature = '';
    },
    render: (
      source: WebGLTexture,
      sourceWidth: number,
      sourceHeight: number,
      planes: readonly Plane[],
      blur: number,
    ) => {
      const next = JSON.stringify([
        sourceWidth,
        sourceHeight,
        blur,
        planes.map(({ uvRect, size, opaque }) => [uvRect, size, opaque]),
      ]);
      if (signature === next) return textures[1];
      if (width !== sourceWidth || height !== sourceHeight) {
        width = sourceWidth;
        height = sourceHeight;
        for (const texture of textures) {
          gl.bindTexture(gl.TEXTURE_2D, texture);
          // Half-float intermediates avoid quantizing dark linear gradients between passes.
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            halfFloat ? gl.RGBA16F : gl.RGBA8,
            width,
            height,
            0,
            gl.RGBA,
            halfFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
            null,
          );
        }
      }
      gl.useProgram(program);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      try {
        gl.uniform1i(locations.uInput, 0);
        gl.uniform2f(locations.uSize, width, height);
        for (let pass = 0; pass < 2; pass++) {
          gl.framebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            textures[pass],
            0,
          );
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            throw new Error('Glass prefilter framebuffer unavailable.');
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.bindTexture(gl.TEXTURE_2D, pass === 0 ? source : textures[0]);
          gl.uniform1i(locations.uFirst, pass === 0 ? 1 : 0);
          gl.uniform2f(locations.uAxis, pass === 0 ? 1 : 0, pass === 1 ? 1 : 0);
          for (const plane of planes) {
            const rect = plane.uvRect ?? [0, 0, 1, 1];
            const x = Math.round(rect[0] * width);
            const y = Math.round(rect[1] * height);
            const w = Math.max(1, Math.round(rect[2] * width));
            const h = Math.max(1, Math.round(rect[3] * height));
            gl.viewport(x, y, w, h);
            gl.uniform4f(locations.uRect, x / width, y / height, w / width, h / height);
            gl.uniform1f(
              locations.uSigma,
              Math.min(32, blur * (pass === 0 ? w / plane.size[0] : h / plane.size[1])),
            );
            gl.uniform1i(locations.uOpaque, plane.opaque ? 1 : 0);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
          }
        }
        signature = next;
        return textures[1];
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
    },
  };
}
