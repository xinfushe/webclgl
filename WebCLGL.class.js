/*
The MIT License (MIT)

Copyright (c) <2013> <Roberto Gonzalez. http://stormcolour.appspot.com/>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
 */

var webCLGLDirectory = document.querySelector('script[src$="WebCLGL.class.js"]').getAttribute('src');
var page = webCLGLDirectory.split('/').pop();
webCLGLDirectory = webCLGLDirectory.replace('/'+page,"");

var includesF = ['/WebCLGLUtils.class.js',
    '/WebCLGLBuffer.class.js',
    '/WebCLGLKernel.class.js',
    '/WebCLGLVertexFragmentProgram.class.js',
    '/WebCLGLFor.class.js'];
for(var n = 0, f = includesF.length; n < f; n++) document.write('<script type="text/javascript" src="'+webCLGLDirectory+includesF[n]+'"></script>');

/**
* Class for parallelization of calculations using the WebGL context similarly to webcl
* @class
* @param {WebGLRenderingContext} [webglcontext=null]
*/
var WebCLGL = function(webglcontext) {
    "use strict";

    this.utils = new WebCLGLUtils();

    this._gl = null;
    this.e = undefined;
    if(webglcontext == undefined) {
        this.e = document.createElement('canvas');
        this.e.width = 32;
        this.e.height = 32;
        this._gl = this.utils.getWebGLContextFromCanvas(this.e, {antialias: false});
    } else this._gl = webglcontext;

    this._arrExt = {"OES_texture_float":null, "OES_texture_float_linear":null, "OES_element_index_uint":null, "WEBGL_draw_buffers":null};
    for(var key in this._arrExt) {
        this._arrExt[key] = this._gl.getExtension(key);
        if(this._arrExt[key] == null)
            console.error("extension "+key+" not available");
    }
    this._maxDrawBuffers = null;
    if(this._arrExt.hasOwnProperty("WEBGL_draw_buffers") && this._arrExt["WEBGL_draw_buffers"] != null) {
        this._maxDrawBuffers = this._gl.getParameter(this._arrExt["WEBGL_draw_buffers"].MAX_DRAW_BUFFERS_WEBGL);
        console.log("Max draw buffers: "+this._maxDrawBuffers);
    } else
        console.log("Max draw buffers: 1");

    var highPrecisionSupport = this._gl.getShaderPrecisionFormat(this._gl.FRAGMENT_SHADER, this._gl.HIGH_FLOAT);
    this.precision = (highPrecisionSupport.precision != 0) ? 'precision highp float;\n\nprecision highp int;\n\n' : 'precision lowp float;\n\nprecision lowp int;\n\n';
    //this.precision = '#version 300 es\nprecision highp float;\n\nprecision highp int;\n\n';
    this._currentTextureUnit = 0;
    this._bufferWidth = 0;

    // QUAD
    var mesh = this.utils.loadQuad(undefined,1.0,1.0);
    this.vertexBuffer_QUAD = this._gl.createBuffer();
    this._gl.bindBuffer(this._gl.ARRAY_BUFFER, this.vertexBuffer_QUAD);
    this._gl.bufferData(this._gl.ARRAY_BUFFER, new Float32Array(mesh.vertexArray), this._gl.STATIC_DRAW);
    this.indexBuffer_QUAD = this._gl.createBuffer();
    this._gl.bindBuffer(this._gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer_QUAD);
    this._gl.bufferData(this._gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mesh.indexArray), this._gl.STATIC_DRAW);


    this.arrayCopyTex = [];

    // SHADER READPIXELS
    var sourceVertex = 	this.precision+
            'attribute vec3 aVertexPosition;\n'+
            'varying vec2 vCoord;\n'+

            'void main(void) {\n'+
                'gl_Position = vec4(aVertexPosition, 1.0);\n'+
                'vCoord = aVertexPosition.xy*0.5+0.5;\n'+
            '}\n';
    var sourceFragment = this.precision+
            'uniform sampler2D sampler_buffer;\n'+
            'varying vec2 vCoord;\n'+

            //'out vec4 fragmentColor;'+
            'void main(void) {\n'+
                'gl_FragColor = texture2D(sampler_buffer, vCoord);'+
            '}\n';

    this.shader_readpixels = this._gl.createProgram();
    this.utils.createShader(this._gl, "CLGLREADPIXELS", sourceVertex, sourceFragment, this.shader_readpixels);

    this.attr_VertexPos = this._gl.getAttribLocation(this.shader_readpixels, "aVertexPosition");
    this.sampler_buffer = this._gl.getUniformLocation(this.shader_readpixels, "sampler_buffer");

    // SHADER COPYTEXTURE
    var lines_drawBuffersEnable = (function() {
        return ((this._maxDrawBuffers != null) ? '#extension GL_EXT_draw_buffers : require\n' : "");
    }).bind(this);
    var lines_drawBuffersWriteInit = (function() {
        var str = '';
        for(var n= 0, fn=this._maxDrawBuffers; n < fn; n++)
            str += 'layout(location = '+n+') out vec4 outCol'+n+';\n';

        return str;
    }).bind(this);
    var lines_drawBuffersWrite = (function() {
        var str = '';
        for(var n= 0, fn=this._maxDrawBuffers; n < fn; n++)
            str += 'gl_FragData['+n+'] = texture2D(uArrayCT['+n+'], vCoord);\n';

        return str;
    }).bind(this);
    sourceVertex = 	""+
        this.precision+
        'attribute vec3 aVertexPosition;\n'+
        'varying vec2 vCoord;\n'+

        'void main(void) {\n'+
            'gl_Position = vec4(aVertexPosition, 1.0);\n'+
            'vCoord = aVertexPosition.xy*0.5+0.5;\n'+
        '}';
    sourceFragment = lines_drawBuffersEnable()+
        this.precision+

        'uniform sampler2D uArrayCT['+this._maxDrawBuffers+'];\n'+

        'varying vec2 vCoord;\n'+

        //lines_drawBuffersWriteInit()+
        'void main(void) {\n'+
            lines_drawBuffersWrite()+
        '}';
    this.shader_copyTexture = this._gl.createProgram();
    this.utils.createShader(this._gl, "CLGLCOPYTEXTURE", sourceVertex, sourceFragment, this.shader_copyTexture);

    this.attr_copyTexture_pos = this._gl.getAttribLocation(this.shader_copyTexture, "aVertexPosition");

    for(var n= 0, fn=this._maxDrawBuffers; n < fn; n++)
        this.arrayCopyTex[n] = this._gl.getUniformLocation(this.shader_copyTexture, "uArrayCT["+n+"]");



    this.textureDataAux = this._gl.createTexture();
    this._gl.bindTexture(this._gl.TEXTURE_2D, this.textureDataAux);
    this._gl.texImage2D(this._gl.TEXTURE_2D, 0, this._gl.RGBA, 2, 2, 0, this._gl.RGBA, this._gl.FLOAT, new Float32Array([1,0,0,1, 0,1,0,1, 0,0,1,1, 1,1,1,1]));
    this._gl.texParameteri(this._gl.TEXTURE_2D, this._gl.TEXTURE_MAG_FILTER, this._gl.NEAREST);
    this._gl.texParameteri(this._gl.TEXTURE_2D, this._gl.TEXTURE_MIN_FILTER, this._gl.NEAREST);
    this._gl.texParameteri(this._gl.TEXTURE_2D, this._gl.TEXTURE_WRAP_S, this._gl.CLAMP_TO_EDGE);
    this._gl.texParameteri(this._gl.TEXTURE_2D, this._gl.TEXTURE_WRAP_T, this._gl.CLAMP_TO_EDGE);
    this._gl.bindTexture(this._gl.TEXTURE_2D, null);


    /**
     * getContext
     * @returns {WebGLRenderingContext}
     */
    this.getContext = function() {
        return this._gl;
    };

    /**
     * getMaxDrawBuffers
     * @returns {int}
     */
    this.getMaxDrawBuffers = function() {
        return this._maxDrawBuffers;
    };

    /**
     * copy
     * @param {WebCLGLKernel|WebCLGLVertexFragmentProgram} pgr
     * @param {Array<WebCLGLBuffer>} [webCLGLBuffers=null]
     */
    this.copy = function(pgr, webCLGLBuffers) {
        if(webCLGLBuffers != null) {
            if(webCLGLBuffers[0] != null) {
                this._gl.viewport(0, 0, webCLGLBuffers[0].W, webCLGLBuffers[0].H);

                this._gl.bindFramebuffer(this._gl.FRAMEBUFFER, webCLGLBuffers[0].fBuffer);
                var arrDBuff = [];
                for(var n= 0, fn=webCLGLBuffers.length; n < fn; n++) {
                    if(webCLGLBuffers[n] != null) {
                        this._gl.framebufferTexture2D(this._gl.FRAMEBUFFER, this._arrExt["WEBGL_draw_buffers"]['COLOR_ATTACHMENT'+n+'_WEBGL'], this._gl.TEXTURE_2D, webCLGLBuffers[n].textureData, 0);
                        arrDBuff[n] = this._arrExt["WEBGL_draw_buffers"]['COLOR_ATTACHMENT'+n+'_WEBGL'];
                    } else
                        arrDBuff[n] = this._gl['NONE'];
                }
                this._arrExt["WEBGL_draw_buffers"].drawBuffersWEBGL(arrDBuff);

                this._gl.useProgram(this.shader_copyTexture);

                for(var n= 0, fn=webCLGLBuffers.length; n < fn; n++) {
                    this._gl.activeTexture(this._gl["TEXTURE"+n]);
                    if(webCLGLBuffers[n] != null)
                        this._gl.bindTexture(this._gl.TEXTURE_2D, webCLGLBuffers[n].textureDataTemp);
                    else
                        this._gl.bindTexture(this._gl.TEXTURE_2D, this.textureDataAux);
                    this._gl.uniform1i(this.arrayCopyTex[n], n);
                }

                this.copyNow(webCLGLBuffers);
            } else {
                this._gl.bindFramebuffer(this._gl.FRAMEBUFFER, null);
            }
        } else
            this._gl.bindFramebuffer(this._gl.FRAMEBUFFER, null);
    };

    this.copyNow = function(webCLGLBuffers) {
        this._gl.enableVertexAttribArray(this.attr_copyTexture_pos);
        this._gl.bindBuffer(this._gl.ARRAY_BUFFER, this.vertexBuffer_QUAD);
        this._gl.vertexAttribPointer(this.attr_copyTexture_pos, 3, this._gl.FLOAT, false, 0, 0);

        this._gl.bindBuffer(this._gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer_QUAD);
        this._gl.drawElements(this._gl.TRIANGLES, 6, this._gl.UNSIGNED_SHORT, 0);
    };

    /**
     * Create a empty WebCLGLBuffer
     * @param {String} [type="FLOAT"] type FLOAT4 OR FLOAT
     * @param {boolean} [linear=false] linear texParameteri type for the WebGLTexture
     * @param {String} [mode="SAMPLER"] Mode for this buffer. "SAMPLER", "ATTRIBUTE", "VERTEX_INDEX"
     * @returns {WebCLGLBuffer}
     */
    this.createBuffer = function(type, linear, mode) {
        return new WebCLGLBuffer(this._gl, type, linear, mode);
    };

    /**
     * Create a kernel
     * @returns {WebCLGLKernel}
     * @param {String} [source=undefined]
     * @param {String} [header=undefined] Additional functions
     */
    this.createKernel = function(source, header) {
        return new WebCLGLKernel(this._gl, source, header);
    };

    /**
     * Create a vertex and fragment programs for a WebGL graphical representation after some enqueueNDRangeKernel
     * @returns {WebCLGLVertexFragmentProgram}
     * @param {String} [vertexSource=undefined]
     * @param {String} [vertexHeader=undefined]
     * @param {String} [fragmentSource=undefined]
     * @param {String} [fragmentHeader=undefined]
     */
    this.createVertexFragmentProgram = function(vertexSource, vertexHeader, fragmentSource, fragmentHeader) {
        return new WebCLGLVertexFragmentProgram(this._gl, vertexSource, vertexHeader, fragmentSource, fragmentHeader);
    };

    /**
     * fillBuffer with color
     * @param {WebGLTexture} texture
     * @param {Array<Float>} clearColor
     * @param {WebGLFramebuffer} fBuffer
     */
    this.fillBuffer = function(texture, clearColor, fBuffer) {
        this._gl.bindFramebuffer(this._gl.FRAMEBUFFER, fBuffer);
        this._gl.framebufferTexture2D(this._gl.FRAMEBUFFER, this._arrExt["WEBGL_draw_buffers"]['COLOR_ATTACHMENT0_WEBGL'], this._gl.TEXTURE_2D, texture, 0);

        var arrDBuff = [this._arrExt["WEBGL_draw_buffers"]['COLOR_ATTACHMENT0_WEBGL']];
        this._arrExt["WEBGL_draw_buffers"].drawBuffersWEBGL(arrDBuff);

        if(clearColor != undefined)
            this._gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
        this._gl.clear(this._gl.COLOR_BUFFER_BIT);
    };

    /**
     * bindAttributeValue
     * @param {Object} inValue
     * @param {WebCLGLBuffer} buff
     */
    this.bindAttributeValue = function(inValue, buff) {
        if(buff != null) {
            if(inValue.type == 'float4_fromAttr') {
                this._gl.enableVertexAttribArray(inValue.location[0]);
                this._gl.bindBuffer(this._gl.ARRAY_BUFFER, buff.vertexData0);
                this._gl.vertexAttribPointer(inValue.location[0], 4, this._gl.FLOAT, false, 0, 0);
            } else if(inValue.type == 'float_fromAttr') {
                this._gl.enableVertexAttribArray(inValue.location[0]);
                this._gl.bindBuffer(this._gl.ARRAY_BUFFER, buff.vertexData0);
                this._gl.vertexAttribPointer(inValue.location[0], 1, this._gl.FLOAT, false, 0, 0);
            }
        } else
            this._gl.disableVertexAttribArray(inValue.location[0]);
    };

    /**
     * bindSamplerValue
     * @param {WebGLUniformLocation} uBufferWidth
     * @param {Object} inValue
     * @param {WebCLGLBuffer} buff
     */
    this.bindSamplerValue = function(uBufferWidth, inValue, buff) {
        if(this._currentTextureUnit < 16)
            this._gl.activeTexture(this._gl["TEXTURE"+this._currentTextureUnit]);
        else
            this._gl.activeTexture(this._gl["TEXTURE16"]);

        if(buff != null) {
            this._gl.bindTexture(this._gl.TEXTURE_2D, buff.textureData);

            if(this._bufferWidth == 0) {
                this._bufferWidth = buff.W;
                this._gl.uniform1f(uBufferWidth, this._bufferWidth);
            }
        } else
            this._gl.bindTexture(this._gl.TEXTURE_2D, this.textureDataAux);
        this._gl.uniform1i(inValue.location[0], this._currentTextureUnit);

        this._currentTextureUnit++;
    };

    /**
     * bindUniformValue
     * @param {Object} inValue
     * @param {WebCLGLBuffer|Number|Array<float>} buff
     */
    this.bindUniformValue = function(inValue, buff) {
        if(buff != null) {
            if(inValue.type == 'float')
                this._gl.uniform1f(inValue.location[0], buff);
            else if(inValue.type == 'float4')
                this._gl.uniform4f(inValue.location[0], buff[0], buff[1], buff[2], buff[3]);
            else if(inValue.type == 'mat4')
                this._gl.uniformMatrix4fv(inValue.location[0], false, buff);
        }
    };

    /**
     * bindValue
     * @param {WebCLGLKernel|WebCLGLVertexFragmentProgram} webCLGLProgram
     * @param {Object} inValue
     * @param {WebCLGLBuffer|float|Array<float>|Float32Array|Uint8Array} argValue
     */
    this.bindValue = function(webCLGLProgram, inValue, argValue) {
        switch(inValue.expectedMode) {
            case "ATTRIBUTE":
                this.bindAttributeValue(inValue, argValue);
                break;
            case "SAMPLER":
                this.bindSamplerValue(webCLGLProgram.uBufferWidth, inValue, argValue);
                break;
            case "UNIFORM":
                this.bindUniformValue(inValue, argValue);
                break;
        }
    };

    /**
     * bindFB
     * @param {Array<WebCLGLBuffer>} [webCLGLBuffers=null]
     * @param {boolean} outputToTemp
     */
    this.bindFB = function(webCLGLBuffers, outputToTemp) {
        if(webCLGLBuffers != null) {
            if(webCLGLBuffers[0] != null) {
                this._gl.viewport(0, 0, webCLGLBuffers[0].W, webCLGLBuffers[0].H);

                this._gl.bindFramebuffer(this._gl.FRAMEBUFFER, ((outputToTemp == true) ? webCLGLBuffers[0].fBufferTemp:webCLGLBuffers[0].fBuffer));
                var arrDBuff = [];
                for(var n= 0, fn=webCLGLBuffers.length; n < fn; n++) {
                    if(webCLGLBuffers[n] != null) {
                        var o = (outputToTemp == true) ? webCLGLBuffers[n].textureDataTemp : webCLGLBuffers[n].textureData;
                        this._gl.framebufferTexture2D(this._gl.FRAMEBUFFER, this._arrExt["WEBGL_draw_buffers"]['COLOR_ATTACHMENT'+n+'_WEBGL'], this._gl.TEXTURE_2D, o, 0);
                        arrDBuff[n] = this._arrExt["WEBGL_draw_buffers"]['COLOR_ATTACHMENT'+n+'_WEBGL'];
                    } else
                        arrDBuff[n] = this._gl['NONE'];
                }
                this._arrExt["WEBGL_draw_buffers"].drawBuffersWEBGL(arrDBuff);

                // checkFramebufferStatus
                var sta = this._gl.checkFramebufferStatus(this._gl.FRAMEBUFFER);
                var ferrors = {};
                ferrors[this._gl.FRAMEBUFFER_COMPLETE] = true;
                ferrors[this._gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT] = "FRAMEBUFFER_INCOMPLETE_ATTACHMENT: The attachment types are mismatched or not all framebuffer attachment points are framebuffer attachment complete";
                ferrors[this._gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT] = "FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT: There is no attachment";
                ferrors[this._gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS] = "FRAMEBUFFER_INCOMPLETE_DIMENSIONS: Height and width of the attachment are not the same";
                ferrors[this._gl.FRAMEBUFFER_UNSUPPORTED] = "FRAMEBUFFER_UNSUPPORTED: The format of the attachment is not supported or if depth and stencil attachments are not the same renderbuffer";
                if(ferrors[sta] != true)
                    console.log(ferrors[sta]);
            } else
                this._gl.bindFramebuffer(this._gl.FRAMEBUFFER, null);
        } else
            this._gl.bindFramebuffer(this._gl.FRAMEBUFFER, null);
    };

    /**
     * Perform calculation and save the result on a WebCLGLBuffer
     * @param {WebCLGLKernel} webCLGLKernel
     * @param {WebCLGLBuffer|Array<WebCLGLBuffer>} [webCLGLBuffer=null]
     * @param {boolean} outputToTemp
     * @param {Object} argValues
     */
    this.enqueueNDRangeKernel = function(webCLGLKernel, webCLGLBuffer, outputToTemp, argValues) {
        this._bufferWidth = 0;

        this._gl.useProgram(webCLGLKernel.kernel);

        this.bindFB(webCLGLBuffer, outputToTemp);

        this._currentTextureUnit = 0;
        for(var key in webCLGLKernel.in_values)
            this.bindValue(webCLGLKernel, webCLGLKernel.in_values[key], argValues[key]);

        this._gl.enableVertexAttribArray(webCLGLKernel.attr_VertexPos);
        this._gl.bindBuffer(this._gl.ARRAY_BUFFER, this.vertexBuffer_QUAD);
        this._gl.vertexAttribPointer(webCLGLKernel.attr_VertexPos, 3, this._gl.FLOAT, false, 0, 0);

        this._gl.bindBuffer(this._gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer_QUAD);
        this._gl.drawElements(this._gl.TRIANGLES, 6, this._gl.UNSIGNED_SHORT, 0);
    };

    /**
     * Perform WebGL graphical representation
     * @param {WebCLGLVertexFragmentProgram} webCLGLVertexFragmentProgram
     * @param {WebCLGLBuffer} bufferInd Buffer to draw type (type indices or vertex)
     * @param {int} [drawMode=4] 0=POINTS, 3=LINE_STRIP, 2=LINE_LOOP, 1=LINES, 5=TRIANGLE_STRIP, 6=TRIANGLE_FAN and 4=TRIANGLES
     * @param {WebCLGLBuffer|Array<WebCLGLBuffer>} [webCLGLBuffer=null]
     * @param {boolean} outputToTemp
     * @param {Object} argValues
     */
    this.enqueueVertexFragmentProgram = function(webCLGLVertexFragmentProgram, bufferInd, drawMode, webCLGLBuffer, outputToTemp, argValues) {
        this._bufferWidth = 0;

        this._gl.useProgram(webCLGLVertexFragmentProgram.vertexFragmentProgram);

        var Dmode = (drawMode != undefined) ? drawMode : 4;

        this.bindFB(webCLGLBuffer, outputToTemp);

        if(bufferInd != undefined) {
            this._currentTextureUnit = 0;
            for(var key in webCLGLVertexFragmentProgram.in_vertex_values)
                this.bindValue(webCLGLVertexFragmentProgram, webCLGLVertexFragmentProgram.in_vertex_values[key], argValues[key]);

            for(var key in webCLGLVertexFragmentProgram.in_fragment_values)
                this.bindValue(webCLGLVertexFragmentProgram, webCLGLVertexFragmentProgram.in_fragment_values[key], argValues[key]);

            if(bufferInd.mode == "VERTEX_INDEX") {
                this._gl.bindBuffer(this._gl.ELEMENT_ARRAY_BUFFER, bufferInd.vertexData0);
                this._gl.drawElements(Dmode, bufferInd.length, this._gl.UNSIGNED_SHORT, 0);
            } else
                this._gl.drawArrays(Dmode, 0, bufferInd.length);
        }
    };

    /**
     * Get the internally WebGLTexture (type FLOAT), if the WebGLRenderingContext was given.
     * @param {WebCLGLBuffer} buffer
     * @returns {WebGLTexture}
     */
    this.enqueueReadBuffer_WebGLTexture = function(buffer) {
        return buffer.textureData;
    };

    /**
     * Get Float32Array array from a WebCLGLBuffer
     * @param {WebCLGLBuffer} buffer
     * @returns {Float32Array}
     */
    this.readBuffer = function(buffer) {
        if(this.e != undefined) {
            this.e.width = buffer.W;
            this.e.height = buffer.H;
        }

        this._gl.useProgram(this.shader_readpixels);

        this._gl.viewport(0, 0, buffer.W, buffer.H);
        this._gl.bindFramebuffer(this._gl.FRAMEBUFFER, buffer.fBufferTemp);
        this._gl.framebufferTexture2D(this._gl.FRAMEBUFFER, this._arrExt["WEBGL_draw_buffers"]['COLOR_ATTACHMENT0_WEBGL'], this._gl.TEXTURE_2D, buffer.textureDataTemp, 0);

        var arrDBuff = [this._arrExt["WEBGL_draw_buffers"]['COLOR_ATTACHMENT0_WEBGL']];
        this._arrExt["WEBGL_draw_buffers"].drawBuffersWEBGL(arrDBuff);

        this._gl.activeTexture(this._gl.TEXTURE0);
        this._gl.bindTexture(this._gl.TEXTURE_2D, buffer.textureData);
        this._gl.uniform1i(this.sampler_buffer, 0);

        this._gl.enableVertexAttribArray(this.attr_VertexPos);
        this._gl.bindBuffer(this._gl.ARRAY_BUFFER, this.vertexBuffer_QUAD);
        this._gl.vertexAttribPointer(this.attr_VertexPos, 3, buffer._supportFormat, false, 0, 0);

        this._gl.bindBuffer(this._gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer_QUAD);
        this._gl.drawElements(this._gl.TRIANGLES, 6, this._gl.UNSIGNED_SHORT, 0);

        if(buffer.outArrayFloat == undefined)
            buffer.outArrayFloat = new Float32Array(buffer.W*buffer.H*4);
        this._gl.readPixels(0, 0, buffer.W, buffer.H, this._gl.RGBA, this._gl.FLOAT, buffer.outArrayFloat);

        if(buffer.type == "FLOAT") {
            var fd = new Float32Array(buffer.outArrayFloat.length/4);
            for(var n=0, fn= buffer.outArrayFloat.length/4; n < fn; n++)
                fd[n] = buffer.outArrayFloat[n*4];

            buffer.outArrayFloat = fd;
        }

        return buffer.outArrayFloat;
    };

};


/**
 * gpufor
 * @returns {WebCLGLFor|Array<float>}
 */
var gpufor = function() {
    "use strict";
    var clglFor = new WebCLGLFor();
    var _gl = null;
    if(arguments[0] instanceof WebGLRenderingContext) {
        _gl = arguments[0];

        clglFor.setCtx(_gl);
        clglFor._webCLGL = new WebCLGL(_gl);
        clglFor.iniG(arguments);
        return clglFor;
    } else if(arguments[0] instanceof HTMLCanvasElement) {
        _gl = new WebCLGLUtils().getWebGLContextFromCanvas(arguments[0]);

        clglFor.setCtx(_gl);
        clglFor._webCLGL = new WebCLGL(_gl);
        clglFor.iniG(arguments);
        return clglFor;
    } else {
        _gl = new WebCLGLUtils().getWebGLContextFromCanvas(document.createElement('canvas'), {antialias: false});

        clglFor.setCtx(_gl);
        clglFor._webCLGL = new WebCLGL(_gl);
        return clglFor.ini(arguments);
    }
};