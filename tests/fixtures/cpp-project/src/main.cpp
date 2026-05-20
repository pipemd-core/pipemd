#include "engine.h"
#include <iostream>

int main() {
    DieselEngine diesel;
    diesel.start();
    std::cout << diesel.status() << std::endl;
    return 0;
}