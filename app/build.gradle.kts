plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.autoaim.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.autoaim.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "16.0"
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug") // biar release bisa langsung di-install
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
