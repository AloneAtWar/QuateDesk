plugins {
    id("com.android.application")
}

android {
    namespace = "com.quotadesk.mobile"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.quotadesk.mobile"
        minSdk = 24
        targetSdk = 35
        versionCode = 50
        versionName = "0.5.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.activity:activity:1.10.1")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
