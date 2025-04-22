//earlier in this list is considered smaller
enum SPECIAL_ORDER {
    "alpha",
    "beta",
}
//i'd like to see ai write code *this* horrible
/**
 * @returns 1 if a > b, 0 if a == b, -1 if a < b
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
    let aSections = a.split("-")
    let bSections = b.split("-")

    let aVersion = aSections[0].split(".")
    let bVersion = bSections[0].split(".")
    for (let i = 0; i < Math.max(aVersion.length,bVersion.length); i++) {
        let na = Number(aVersion[i])
        let nb = Number(bVersion[i])
        if ((na > nb) || (!isNaN(na) && isNaN(nb))) { return 1 }
        if ((na < nb) || (isNaN(na) && !isNaN(nb))) { return -1 }
    }

    if (aSections[1] || bSections[1]) {
        let aSpecial = aSections[1]?.split(".") as any[]
        let bSpecial = bSections[1]?.split(".") as any[]
        if (!aSpecial && bSpecial) { return 1 }
        if (aSpecial && !bSpecial) { return -1 }
        if (SPECIAL_ORDER[aSpecial[0]] > SPECIAL_ORDER[bSpecial[0]]) { return 1 }
        if (SPECIAL_ORDER[aSpecial[0]] < SPECIAL_ORDER[bSpecial[0]]) { return -1 }

        let na = Number(aSpecial[1])
        let nb = Number(bSpecial[1])
        if (na > nb || (!isNaN(na) && isNaN(nb))) { return 1 }
        if (na < nb || (isNaN(na) && !isNaN(nb))) { return -1 }
    }

    return 0
}