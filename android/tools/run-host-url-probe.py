"""Optional offline probe using existing cached tooling. Does not change Gradle configuration."""
from pathlib import Path
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path.home() / ".gradle/caches/modules-2/files-2.1"
JAVA = os.environ.get("JAVA", "/opt/homebrew/opt/openjdk@17/bin/java")

def jar(group, artifact, version):
    matches = list((CACHE / group / artifact / version).glob("*/*.jar"))
    if len(matches) != 1:
        raise RuntimeError(f"Expected cached jar: {group}/{artifact}/{version}")
    return str(matches[0])

stdlib = jar("org.jetbrains.kotlin", "kotlin-stdlib", "2.2.20")
annotations = jar("org.jetbrains", "annotations", "13.0")
compiler_cp = os.pathsep.join([
    jar("org.jetbrains.kotlin", "kotlin-compiler-embeddable", "2.2.20"), stdlib, annotations,
    jar("org.jetbrains.kotlin", "kotlin-script-runtime", "2.2.20"),
    jar("org.jetbrains.kotlin", "kotlin-reflect", "1.6.10"),
    jar("org.jetbrains.kotlin", "kotlin-daemon-embeddable", "2.2.20"),
    jar("org.jetbrains.kotlinx", "kotlinx-coroutines-core-jvm", "1.8.0"),
])
print("Supplementary offline JVM probe: JDK17, cached Kotlin2.2.20; not project-locked Gradle/Kotlin2.0.21 or device acceptance.", flush=True)
with tempfile.TemporaryDirectory(prefix="eaglemv-host-url-") as output:
    subprocess.run([JAVA, "-cp", compiler_cp, "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
        "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-classpath", os.pathsep.join([stdlib, annotations]),
        "-d", output, str(ROOT / "app/src/main/java/com/eaglemultiview/android/HostUrlValidator.kt"),
        str(ROOT / "tools/HostUrlProbe.kt")], check=True)
    subprocess.run([JAVA, "-cp", os.pathsep.join([output, stdlib]), "com.eaglemultiview.android.HostUrlProbeKt"], check=True)
