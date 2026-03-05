package ai.offgridmobile.exynos

import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

/**
 * Placeholder bridge for a future Samsung Exynos NPU diffusion backend.
 *
 * This module intentionally fails fast until a real Samsung runtime is linked.
 * The JavaScript layer uses it to detect whether an Exynos-specific backend is
 * present in the current build.
 */
class ExynosNpuDiffusionModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val MODULE_NAME = "ExynosNpuDiffusionModule"
        private const val RUNTIME_ERROR =
            "Exynos NPU runtime is not integrated in this build."

        internal fun isExynosSupportedInternal(): Boolean {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
            return Build.SOC_MODEL.uppercase().startsWith("S5E")
        }
    }

    override fun getName(): String = MODULE_NAME

    override fun getConstants(): Map<String, Any> {
        return mapOf(
            "DEFAULT_STEPS" to 20,
            "DEFAULT_GUIDANCE_SCALE" to 7.5,
            "DEFAULT_WIDTH" to 512,
            "DEFAULT_HEIGHT" to 512,
            "SUPPORTED_WIDTHS" to listOf(128, 192, 256, 320, 384, 448, 512),
            "SUPPORTED_HEIGHTS" to listOf(128, 192, 256, 320, 384, 448, 512),
        )
    }

    @ReactMethod
    fun isRuntimeAvailable(promise: Promise) {
        promise.resolve(false)
    }

    @ReactMethod
    fun loadModel(params: ReadableMap, promise: Promise) {
        promise.reject("RUNTIME_UNAVAILABLE", RUNTIME_ERROR)
    }

    @ReactMethod
    fun unloadModel(promise: Promise) {
        promise.resolve(true)
    }

    @ReactMethod
    fun isModelLoaded(promise: Promise) {
        promise.resolve(false)
    }

    @ReactMethod
    fun getLoadedModelPath(promise: Promise) {
        promise.resolve(null)
    }

    @ReactMethod
    fun generateImage(params: ReadableMap, promise: Promise) {
        promise.reject("RUNTIME_UNAVAILABLE", RUNTIME_ERROR)
    }

    @ReactMethod
    fun cancelGeneration(promise: Promise) {
        promise.resolve(true)
    }

    @ReactMethod
    fun isGenerating(promise: Promise) {
        promise.resolve(false)
    }

    @ReactMethod
    fun getGeneratedImages(promise: Promise) {
        promise.resolve(Arguments.createArray())
    }

    @ReactMethod
    fun deleteGeneratedImage(imageId: String, promise: Promise) {
        promise.resolve(false)
    }

    @ReactMethod
    fun isNpuSupported(promise: Promise) {
        promise.resolve(isExynosSupportedInternal())
    }

    @ReactMethod
    fun getSoCModel(promise: Promise) {
        val soc = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Build.SOC_MODEL
        } else {
            ""
        }
        promise.resolve(soc)
    }

    @ReactMethod
    fun getAndroidBuildInfo(promise: Promise) {
        val map = Arguments.createMap().apply {
            putString("socModel", if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) Build.SOC_MODEL else "")
            putString("socManufacturer", if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) Build.SOC_MANUFACTURER else "")
            putString("hardware", Build.HARDWARE ?: "")
            putString("board", Build.BOARD ?: "")
            putString("product", Build.PRODUCT ?: "")
            putString("device", Build.DEVICE ?: "")
            putString("manufacturer", Build.MANUFACTURER ?: "")
            putString("model", Build.MODEL ?: "")
        }
        promise.resolve(map)
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Required for RN event emitter compatibility.
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required for RN event emitter compatibility.
    }
}
